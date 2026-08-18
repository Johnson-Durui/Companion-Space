import asyncio
import json
import os
import queue
import sys
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import (
    InferenceCancelledError,
    MODEL_ID,
    MODEL_REVISION,
    SOURCE_MODEL_ID,
    Runtime,
    SpeechRequest,
    create_app,
    load_qwen_model,
    to_pcm16,
)


class FakeModel:
    def __init__(self) -> None:
        self.calls = []

    def generate_custom_voice(self, **kwargs):
        self.calls.append(kwargs)
        return [np.array([-2.0, -0.5, 0.0, 0.5, 2.0], dtype=np.float32)], 24_000


class FakeQueue:
    def __init__(self) -> None:
        self.items = []
        self.closed = 0

    def put(self, item) -> None:
        self.items.append(item)

    def get_nowait(self):
        if not self.items:
            raise queue.Empty
        return self.items.pop(0)

    def close(self) -> None:
        self.closed += 1

    def cancel_join_thread(self) -> None:
        return None


class FakeWorker:
    def __init__(self) -> None:
        self.alive = True
        self.terminated = 0
        self.closed = 0

    def is_alive(self) -> bool:
        return self.alive

    def start(self) -> None:
        return None

    def terminate(self) -> None:
        self.terminated += 1
        self.alive = False

    def join(self, timeout=None) -> None:
        return None

    def kill(self) -> None:
        self.alive = False

    def close(self) -> None:
        self.closed += 1


class SidecarTests(unittest.TestCase):
    def test_only_public_model_slug_is_accepted(self) -> None:
        SpeechRequest(model="qwen3-tts-0.6b-customvoice", input="你好", voice="Vivian")
        with self.assertRaises(ValidationError):
            SpeechRequest(
                model="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
                input="你好",
                voice="Vivian",
            )

    def test_fake_model_alias_and_pcm_contract(self) -> None:
        fake = FakeModel()
        runtime = Runtime(loader=lambda: fake)
        request = SpeechRequest(model=MODEL_ID, input="你好", voice="nova", response_format="pcm")

        pcm = asyncio.run(runtime.synthesize(request))

        self.assertEqual(len(pcm), 10)
        self.assertEqual(
            fake.calls[0],
            {
                "text": "你好",
                "language": "Chinese",
                "speaker": "Vivian",
                "instruct": "温柔亲切，节奏舒缓。",
            },
        )

    def test_emotion_profiles_change_qwen_instruction_and_clamp_speed(self) -> None:
        fake = FakeModel()
        runtime = Runtime(loader=lambda: fake)

        with patch("app.to_pcm16", return_value=b"\x00\x00") as convert:
            asyncio.run(
                runtime.synthesize(
                    SpeechRequest(
                        model=MODEL_ID,
                        input="来试试看。",
                        voice="Vivian",
                        emotion="playful",
                    )
                )
            )
            playful_speed = convert.call_args.args[2]
            asyncio.run(
                runtime.synthesize(
                    SpeechRequest(
                        model=MODEL_ID,
                        input="慢慢来。",
                        voice="Vivian",
                        emotion="concerned",
                    )
                )
            )
            concerned_speed = convert.call_args.args[2]
            asyncio.run(
                runtime.synthesize(
                    SpeechRequest(
                        model=MODEL_ID,
                        input="来试试看。",
                        voice="Vivian",
                        speed=2.0,
                        emotion="playful",
                    )
                )
            )
            playful_clamped_speed = convert.call_args.args[2]
            asyncio.run(
                runtime.synthesize(
                    SpeechRequest(
                        model=MODEL_ID,
                        input="慢慢来。",
                        voice="Vivian",
                        speed=0.5,
                        emotion="concerned",
                    )
                )
            )
            concerned_clamped_speed = convert.call_args.args[2]

        self.assertEqual(playful_speed, 1.1)
        self.assertEqual(concerned_speed, 0.9)
        self.assertEqual(playful_clamped_speed, 2.0)
        self.assertEqual(concerned_clamped_speed, 0.5)
        self.assertNotEqual(fake.calls[0]["instruct"], fake.calls[1]["instruct"])
        self.assertEqual({call["speaker"] for call in fake.calls}, {"Vivian"})

    def test_unknown_emotion_is_rejected_at_the_sidecar_boundary(self) -> None:
        with self.assertRaises(ValidationError):
            SpeechRequest(
                model=MODEL_ID,
                input="你好",
                voice="Vivian",
                emotion="angry",
            )

    def test_speech_endpoint_response_headers(self) -> None:
        app = create_app(Runtime(loader=FakeModel))
        with TestClient(app) as client:
            response = client.post(
                "/v1/audio/speech",
                json={
                    "model": MODEL_ID,
                    "input": "你好",
                    "voice": "Vivian",
                    "response_format": "pcm",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/octet-stream")
        self.assertEqual(response.headers["x-audio-format"], "pcm_s16le")
        self.assertEqual(response.headers["x-audio-channels"], "1")
        self.assertEqual(response.headers["x-audio-sample-rate"], "24000")

    def test_models_endpoint_reports_public_slug_and_pinned_source(self) -> None:
        with TestClient(create_app(Runtime(loader=FakeModel))) as client:
            model = client.get("/v1/models").json()["data"][0]

        self.assertEqual(model["id"], MODEL_ID)
        self.assertEqual(model["source_model"], SOURCE_MODEL_ID)
        self.assertEqual(model["revision"], MODEL_REVISION)

    def test_loader_pins_snapshot_then_loads_only_the_local_copy(self) -> None:
        calls: dict[str, object] = {}
        model = object()
        bfloat16 = object()

        def snapshot_download(**kwargs):
            calls["snapshot"] = kwargs
            return "D:/cache/snapshots/pinned"

        class FakeQwenModel:
            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                calls["from_pretrained"] = (args, kwargs)
                return model

        fake_torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True),
            bfloat16=bfloat16,
            float32=object(),
        )
        fake_huggingface_hub = SimpleNamespace(snapshot_download=snapshot_download)
        fake_qwen_tts = SimpleNamespace(Qwen3TTSModel=FakeQwenModel)

        with (
            patch.dict(
                sys.modules,
                {
                    "torch": fake_torch,
                    "huggingface_hub": fake_huggingface_hub,
                    "qwen_tts": fake_qwen_tts,
                },
            ),
            patch.dict(
                os.environ,
                {"TTS_DEVICE": "cuda", "TTS_MODEL_CACHE": "D:/cache"},
                clear=False,
            ),
        ):
            loaded = load_qwen_model()

        self.assertIs(loaded, model)
        self.assertEqual(
            calls["snapshot"],
            {
                "repo_id": SOURCE_MODEL_ID,
                "revision": MODEL_REVISION,
                "cache_dir": "D:/cache",
            },
        )
        args, kwargs = calls["from_pretrained"]
        self.assertEqual(args, ("D:/cache/snapshots/pinned",))
        self.assertTrue(kwargs["local_files_only"])
        self.assertTrue(kwargs["use_safetensors"])
        self.assertEqual(kwargs["device_map"], "cuda:0")
        self.assertIs(kwargs["dtype"], bfloat16)
        self.assertEqual(kwargs["attn_implementation"], "sdpa")

    def test_rejects_non_finite_and_empty_audio(self) -> None:
        with self.assertRaises(ValueError):
            to_pcm16(np.array([], dtype=np.float32), 24_000, 1.0)
        with self.assertRaises(ValueError):
            to_pcm16(np.array([np.nan], dtype=np.float32), 24_000, 1.0)

    def test_cancelled_request_terminates_worker_before_rewarming(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = FakeWorker()
            request_queue = FakeQueue()
            runtime._worker = worker
            runtime._request_queue = request_queue
            runtime._response_queue = FakeQueue()
            entered = asyncio.Event()
            reloads = 0

            async def wait_forever(**kwargs):
                entered.set()
                await asyncio.Future()

            async def reload_after_cancel():
                nonlocal reloads
                reloads += 1

            runtime._read_worker_response = wait_forever
            runtime.load = reload_after_cancel
            task = asyncio.create_task(
                runtime.synthesize(
                    SpeechRequest(model=MODEL_ID, input="请停止。", voice="Serena")
                )
            )
            await entered.wait()
            self.assertFalse(await runtime.cancel("wrong-job"))
            self.assertEqual(worker.terminated, 0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.gather(*tuple(runtime._cleanup_tasks))

            self.assertEqual(worker.terminated, 1)
            self.assertEqual(reloads, 1)
            self.assertEqual(runtime.status, "loading")
            self.assertEqual(len(request_queue.items), 1)

        asyncio.run(scenario())

    def test_delete_returns_before_gated_cleanup_then_rewarms(self) -> None:
        runtime = Runtime()
        runtime.model = True
        runtime.status = "ready"
        active_worker = FakeWorker()
        replacement_worker = FakeWorker()
        runtime._worker = active_worker
        runtime._request_queue = FakeQueue()
        runtime._response_queue = FakeQueue()
        runtime._active_job_id = "active-job"
        runtime._active_job_worker = active_worker
        cleanup_entered = threading.Event()
        release_cleanup = threading.Event()
        starts = 0

        async def gated_cleanup(worker, request_queue, response_queue) -> None:
            if worker is not active_worker:
                Runtime._stop_generation_sync(worker, request_queue, response_queue)
                return
            cleanup_entered.set()
            await asyncio.to_thread(release_cleanup.wait)
            Runtime._stop_generation_sync(worker, request_queue, response_queue)

        async def start_replacement() -> None:
            nonlocal starts
            starts += 1
            runtime._worker = replacement_worker
            runtime._request_queue = FakeQueue()
            runtime._response_queue = FakeQueue()

        runtime._stop_generation = gated_cleanup
        runtime._start_worker = start_replacement

        with TestClient(create_app(runtime)) as client:
            started = time.perf_counter()
            response = client.delete("/v1/audio/speech/active-job")
            elapsed = time.perf_counter() - started

            self.assertEqual(response.status_code, 204)
            self.assertLess(elapsed, 0.1)
            self.assertTrue(cleanup_entered.wait(timeout=1))
            self.assertEqual(active_worker.terminated, 0)
            self.assertIsNone(runtime._worker)
            release_cleanup.set()
            for _ in range(100):
                if runtime._worker is replacement_worker:
                    break
                time.sleep(0.01)

            self.assertEqual(active_worker.terminated, 1)
            self.assertIs(runtime._worker, replacement_worker)
            self.assertEqual(starts, 1)

    def test_delete_unknown_inference_does_not_terminate_active_worker(self) -> None:
        runtime = Runtime()
        runtime.model = True
        runtime.status = "ready"
        active_worker = FakeWorker()
        runtime._worker = active_worker
        runtime._request_queue = FakeQueue()
        runtime._response_queue = FakeQueue()
        runtime._active_job_id = "active-job"
        runtime._active_job_worker = active_worker

        with TestClient(create_app(runtime)) as client:
            response = client.delete("/v1/audio/speech/other-job")

            self.assertEqual(response.status_code, 404)
            self.assertEqual(active_worker.terminated, 0)
            self.assertIs(runtime._worker, active_worker)

    def test_runtime_cancel_is_idempotent_after_active_job_is_reclaimed(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            active_worker = FakeWorker()
            runtime._worker = active_worker
            runtime._request_queue = FakeQueue()
            runtime._response_queue = FakeQueue()
            runtime._active_job_id = "active-job"
            runtime._active_job_worker = active_worker

            async def reload_after_cancel() -> None:
                return None

            runtime.load = reload_after_cancel

            self.assertTrue(await runtime.cancel("active-job"))
            self.assertFalse(await runtime.cancel("active-job"))
            await asyncio.gather(*tuple(runtime._cleanup_tasks))
            self.assertEqual(active_worker.terminated, 1)

        asyncio.run(scenario())

    def test_shutdown_cancels_rewarm_without_restarting_a_worker(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            active_worker = FakeWorker()
            runtime._worker = active_worker
            runtime._request_queue = FakeQueue()
            runtime._response_queue = FakeQueue()
            runtime._active_job_id = "active-job"
            runtime._active_job_worker = active_worker
            rewarm_started = asyncio.Event()

            async def blocked_start() -> None:
                rewarm_started.set()
                await asyncio.Future()

            runtime._start_worker = blocked_start

            self.assertTrue(await runtime.cancel("active-job"))
            await rewarm_started.wait()
            await runtime.aclose()
            await asyncio.sleep(0)

            self.assertEqual(active_worker.terminated, 1)
            self.assertIsNone(runtime._worker)
            self.assertIsNone(runtime._rewarm_task)
            self.assertTrue(runtime._closing)

        asyncio.run(scenario())

    def test_cancelling_worker_start_waits_for_process_cleanup(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            worker = FakeWorker()
            entered = asyncio.Event()

            class FakeContext:
                def Queue(self, maxsize=0):
                    return FakeQueue()

                def Process(self, **kwargs):
                    return worker

            async def wait_forever(**kwargs):
                entered.set()
                await asyncio.Future()

            runtime._read_worker_response = wait_forever
            with patch("app.multiprocessing.get_context", return_value=FakeContext()):
                task = asyncio.create_task(runtime._start_worker())
                await entered.wait()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

            self.assertEqual(worker.terminated, 1)
            self.assertIsNone(runtime._worker)
            self.assertIsNone(runtime._request_queue)
            self.assertIsNone(runtime._response_queue)

        asyncio.run(scenario())

    def test_start_retries_a_transient_load_failure(self) -> None:
        async def scenario() -> None:
            attempts = 0
            ready = asyncio.Event()

            def flaky_loader():
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise RuntimeError("transient")
                ready.set()
                return FakeModel()

            runtime = Runtime(loader=flaky_loader)
            runtime.start()
            await asyncio.wait_for(ready.wait(), timeout=3)
            for _ in range(100):
                if runtime.status == "ready":
                    break
                await asyncio.sleep(0.01)

            self.assertEqual(attempts, 2)
            self.assertEqual(runtime.status, "ready")
            self.assertIsNotNone(runtime.model)
            await runtime.aclose()

        asyncio.run(scenario())

    def test_health_detects_an_idle_worker_exit_and_rewarms(self) -> None:
        runtime = Runtime()
        runtime.model = True
        runtime.status = "ready"
        worker = FakeWorker()
        worker.alive = False
        runtime._worker = worker
        runtime._request_queue = FakeQueue()
        runtime._response_queue = FakeQueue()
        scheduled = 0

        def schedule_rewarm() -> None:
            nonlocal scheduled
            scheduled += 1

        app = create_app(runtime)
        runtime._schedule_rewarm = schedule_rewarm
        health_endpoint = next(
            route.endpoint for route in app.routes if route.path == "/healthz"
        )
        response = asyncio.run(health_endpoint())

        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.body)["error"], "WorkerExited")
        self.assertEqual(runtime.status, "error")
        self.assertIsNone(runtime.model)
        self.assertEqual(scheduled, 1)

    def test_worker_exit_marks_unhealthy_and_schedules_rewarm(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = FakeWorker()
            runtime._worker = worker
            runtime._request_queue = FakeQueue()
            runtime._response_queue = FakeQueue()
            scheduled = 0

            def schedule_rewarm() -> None:
                nonlocal scheduled
                scheduled += 1

            async def fail_read(**kwargs):
                self.assertIs(kwargs["worker"], worker)
                self.assertIs(kwargs["response_queue"], runtime._response_queue)
                worker.alive = False
                raise RuntimeError("worker exited")

            runtime._schedule_rewarm = schedule_rewarm
            runtime._read_worker_response = fail_read
            with self.assertRaises(RuntimeError, msg="unexpected worker exit must fail"):
                await runtime.synthesize(
                    SpeechRequest(model=MODEL_ID, input="请继续", voice="Serena"),
                    inference_id="crashed-job",
                )

            self.assertEqual(runtime.status, "error")
            self.assertIsNone(runtime.model)
            self.assertEqual(runtime.error, "RuntimeError")
            self.assertEqual(scheduled, 1)

        asyncio.run(scenario())

    def test_cancelled_generation_cannot_consume_or_stop_replacement_worker(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            old_worker = FakeWorker()
            old_requests = FakeQueue()
            old_responses = FakeQueue()
            replacement_worker = FakeWorker()
            replacement_responses = FakeQueue()
            replacement_responses.put(("startup", True, None))
            replacement_ready = asyncio.Event()
            runtime._worker = old_worker
            runtime._request_queue = old_requests
            runtime._response_queue = old_responses

            async def load_replacement() -> None:
                runtime._worker = replacement_worker
                runtime._request_queue = FakeQueue()
                runtime._response_queue = replacement_responses
                runtime.model = True
                runtime.status = "ready"
                replacement_ready.set()

            runtime.load = load_replacement
            task = asyncio.create_task(
                runtime.synthesize(
                    SpeechRequest(model=MODEL_ID, input="请停止旧语音", voice="Serena"),
                    inference_id="old-job",
                )
            )
            while not old_requests.items:
                await asyncio.sleep(0)

            self.assertTrue(await runtime.cancel("old-job"))
            await replacement_ready.wait()
            with self.assertRaises(RuntimeError):
                await task

            self.assertEqual(old_worker.terminated, 1)
            self.assertEqual(replacement_worker.terminated, 0)
            self.assertIs(runtime._worker, replacement_worker)
            self.assertEqual(replacement_responses.items, [("startup", True, None)])

        asyncio.run(scenario())

    def test_delete_wins_over_a_queued_result_and_post_is_cancelled(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = FakeWorker()
            runtime._worker = worker
            runtime._request_queue = FakeQueue()
            runtime._response_queue = FakeQueue()
            read_started = asyncio.Event()
            release_result = asyncio.Event()

            async def delayed_result(**kwargs):
                read_started.set()
                await release_result.wait()
                return ("active-job", True, b"\x00\x00")

            runtime._read_worker_response = delayed_result
            runtime._schedule_rewarm = lambda: None
            speech_endpoint = next(
                route.endpoint
                for route in create_app(runtime).routes
                if route.path == "/v1/audio/speech"
            )

            async def connected() -> bool:
                return False

            task = asyncio.create_task(
                speech_endpoint(
                    SpeechRequest(model=MODEL_ID, input="请停止", voice="Serena"),
                    SimpleNamespace(is_disconnected=connected),
                    "active-job",
                )
            )
            await read_started.wait()

            self.assertTrue(await runtime.cancel("active-job"))
            release_result.set()
            with self.assertRaises(HTTPException) as raised:
                await task

            self.assertEqual(raised.exception.status_code, 499)
            await asyncio.gather(*tuple(runtime._cleanup_tasks))
            self.assertEqual(worker.terminated, 1)
            await runtime.aclose()

        asyncio.run(scenario())

    def test_retired_generation_cleanup_runs_exactly_once(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = FakeWorker()
            request_queue = FakeQueue()
            response_queue = FakeQueue()
            runtime._worker = worker
            runtime._request_queue = request_queue
            runtime._response_queue = response_queue
            runtime._active_job_id = "active-job"
            runtime._active_job_worker = worker

            async def no_rewarm() -> None:
                return None

            runtime.load = no_rewarm
            self.assertTrue(await runtime.cancel("active-job"))
            await asyncio.gather(*tuple(runtime._cleanup_tasks))
            self.assertEqual(worker.terminated, 1)
            self.assertEqual(worker.closed, 1)
            self.assertEqual(request_queue.closed, 1)
            self.assertEqual(response_queue.closed, 1)
            self.assertFalse(await runtime.cancel("active-job"))
            await runtime.aclose()
            self.assertEqual(worker.terminated, 1)
            self.assertEqual(worker.closed, 1)

        asyncio.run(scenario())

    def test_failed_retired_worker_stop_is_observed_and_never_rewarms(self) -> None:
        class StubbornWorker(FakeWorker):
            def terminate(self) -> None:
                self.terminated += 1

            def kill(self) -> None:
                return None

        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = StubbornWorker()
            request_queue = FakeQueue()
            response_queue = FakeQueue()
            runtime._worker = worker
            runtime._request_queue = request_queue
            runtime._response_queue = response_queue
            runtime._active_job_id = "active-job"
            runtime._active_job_worker = worker
            rewarmed = 0
            starts = 0

            def track_rewarm() -> None:
                nonlocal rewarmed
                rewarmed += 1

            async def track_start() -> None:
                nonlocal starts
                starts += 1

            runtime._schedule_rewarm = track_rewarm
            runtime._start_worker = track_start
            with patch("app.logger.error") as log_error:
                self.assertTrue(await runtime.cancel("active-job"))
                results = await asyncio.gather(
                    *tuple(runtime._cleanup_tasks),
                    return_exceptions=True,
                )
                await asyncio.sleep(0)

            self.assertEqual(len(results), 1)
            self.assertIsInstance(results[0], RuntimeError)
            self.assertEqual(runtime.status, "error")
            self.assertEqual(runtime.error, "RuntimeError")
            self.assertEqual(rewarmed, 0)
            self.assertTrue(worker.is_alive())
            self.assertEqual(request_queue.closed, 1)
            self.assertEqual(response_queue.closed, 1)
            log_error.assert_called_once()
            await runtime.load()
            with self.assertRaises(RuntimeError):
                await runtime.synthesize(
                    SpeechRequest(model=MODEL_ID, input="stop failed", voice="Serena")
                )
            self.assertEqual(starts, 0)

        asyncio.run(scenario())

    def test_failed_worker_recovery_latches_until_process_restart(self) -> None:
        class StubbornWorker(FakeWorker):
            def terminate(self) -> None:
                self.terminated += 1

            def kill(self) -> None:
                return None

        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = StubbornWorker()
            runtime._worker = worker
            runtime._request_queue = FakeQueue()
            runtime._response_queue = FakeQueue()
            runtime._active_job_id = "active-job"
            runtime._active_job_worker = worker
            rewarmed = 0
            starts = 0

            def track_rewarm() -> None:
                nonlocal rewarmed
                rewarmed += 1

            async def track_start() -> None:
                nonlocal starts
                starts += 1

            runtime._schedule_rewarm = track_rewarm
            with self.assertRaises(RuntimeError):
                await runtime._recover_failed_worker(
                    "active-job",
                    worker,
                    "RuntimeError",
                )
            runtime._start_worker = track_start
            await runtime.load()
            with self.assertRaises(RuntimeError):
                await runtime.synthesize(
                    SpeechRequest(model=MODEL_ID, input="stop failed", voice="Serena")
                )

            self.assertTrue(runtime._worker_stop_failed)
            self.assertEqual(runtime.status, "error")
            self.assertEqual(runtime.error, "RuntimeError")
            self.assertEqual(rewarmed, 0)
            self.assertEqual(starts, 0)

        asyncio.run(scenario())

    def test_concurrent_start_rechecks_stop_failure_before_creating_process(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            stop_entered = asyncio.Event()
            release_stop = asyncio.Event()

            async def interleaved_stop(*, expected_worker=None) -> None:
                stop_entered.set()
                await release_stop.wait()

            runtime._stop_worker = interleaved_stop
            with patch("app.multiprocessing.get_context") as get_context:
                start_task = asyncio.create_task(runtime._start_worker())
                await stop_entered.wait()
                runtime._mark_worker_stop_failed(RuntimeError("stubborn worker"))
                release_stop.set()
                with self.assertRaises(RuntimeError):
                    await start_task

            get_context.assert_not_called()
            self.assertTrue(runtime._worker_stop_failed)
            self.assertEqual(runtime.status, "error")
            self.assertIsNone(runtime._worker)

        asyncio.run(scenario())

    def test_start_waits_for_pending_failed_cleanup_before_creating_process(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            cleanup_entered = asyncio.Event()
            release_cleanup = asyncio.Event()

            async def failed_cleanup(worker, request_queue, response_queue) -> None:
                cleanup_entered.set()
                await release_cleanup.wait()
                raise RuntimeError("stubborn retired worker")

            runtime._stop_generation = failed_cleanup
            cleanup_task = asyncio.create_task(
                runtime._cleanup_retired_generation(
                    FakeWorker(),
                    FakeQueue(),
                    FakeQueue(),
                )
            )
            runtime._cleanup_tasks.add(cleanup_task)
            cleanup_task.add_done_callback(runtime._cleanup_task_done)
            await cleanup_entered.wait()

            with (
                patch("app.multiprocessing.get_context") as get_context,
                patch("app.logger.error"),
            ):
                start_task = asyncio.create_task(runtime._start_worker())
                await asyncio.sleep(0)
                self.assertFalse(start_task.done())
                release_cleanup.set()
                with self.assertRaises(RuntimeError):
                    await start_task

            get_context.assert_not_called()
            self.assertTrue(runtime._worker_stop_failed)
            self.assertEqual(runtime.status, "error")
            self.assertIsNone(runtime._worker)

        asyncio.run(scenario())

    def test_shutdown_waits_for_cleanup_and_never_rewarms(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = FakeWorker()
            runtime._worker = worker
            runtime._request_queue = FakeQueue()
            runtime._response_queue = FakeQueue()
            runtime._active_job_id = "active-job"
            runtime._active_job_worker = worker
            cleanup_entered = asyncio.Event()
            release_cleanup = asyncio.Event()
            rewarmed = 0

            async def gated_cleanup(worker, request_queue, response_queue) -> None:
                cleanup_entered.set()
                await release_cleanup.wait()

            def track_rewarm() -> None:
                nonlocal rewarmed
                rewarmed += 1

            runtime._stop_generation = gated_cleanup
            runtime._schedule_rewarm = track_rewarm
            self.assertTrue(await runtime.cancel("active-job"))
            await cleanup_entered.wait()
            close_task = asyncio.create_task(runtime.aclose())
            await asyncio.sleep(0)
            self.assertFalse(close_task.done())
            release_cleanup.set()
            await close_task
            await asyncio.sleep(0)

            self.assertEqual(rewarmed, 0)
            self.assertTrue(runtime._closing)
            self.assertIsNone(runtime._worker)

        asyncio.run(scenario())

    def test_immediate_shutdown_waits_for_detached_worker_cleanup(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = FakeWorker()
            request_queue = FakeQueue()
            response_queue = FakeQueue()
            runtime._worker = worker
            runtime._request_queue = request_queue
            runtime._response_queue = response_queue
            runtime._active_job_id = "active-job"
            runtime._active_job_worker = worker

            self.assertTrue(await runtime.cancel("active-job"))
            await runtime.aclose()

            self.assertEqual(worker.terminated, 1)
            self.assertEqual(worker.closed, 1)
            self.assertEqual(request_queue.closed, 1)
            self.assertEqual(response_queue.closed, 1)
            self.assertTrue(runtime._closing)

        asyncio.run(scenario())

    def test_cancelled_shutdown_still_finishes_detached_worker_cleanup(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            runtime.model = True
            runtime.status = "ready"
            worker = FakeWorker()
            runtime._worker = worker
            runtime._request_queue = FakeQueue()
            runtime._response_queue = FakeQueue()
            runtime._active_job_id = "active-job"
            runtime._active_job_worker = worker
            cleanup_entered = asyncio.Event()
            release_cleanup = asyncio.Event()

            async def gated_cleanup(worker, request_queue, response_queue) -> None:
                cleanup_entered.set()
                await release_cleanup.wait()
                Runtime._stop_generation_sync(worker, request_queue, response_queue)

            runtime._stop_generation = gated_cleanup
            self.assertTrue(await runtime.cancel("active-job"))
            close_task = asyncio.create_task(runtime.aclose())
            await cleanup_entered.wait()
            close_task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(close_task.done())
            release_cleanup.set()
            with self.assertRaises(asyncio.CancelledError):
                await close_task

            self.assertEqual(worker.terminated, 1)
            self.assertEqual(worker.closed, 1)
            self.assertTrue(runtime._closing)

        asyncio.run(scenario())

    def test_retired_worker_closed_queue_is_reported_as_cancelled(self) -> None:
        class ClosedQueue(FakeQueue):
            def get_nowait(self):
                raise ValueError("queue is closed")

        async def scenario() -> None:
            runtime = Runtime()
            old_worker = FakeWorker()
            runtime._worker = FakeWorker()
            runtime._active_job_worker = None

            with self.assertRaises(InferenceCancelledError):
                await runtime._read_worker_response(
                    worker=old_worker,
                    response_queue=ClosedQueue(),
                    timeout=0.1,
                    job_id="retired-job",
                )

        asyncio.run(scenario())

    def test_worker_start_rechecks_closing_after_stopping_old_generation(self) -> None:
        async def scenario() -> None:
            runtime = Runtime()
            stop_entered = asyncio.Event()
            release_stop = asyncio.Event()

            async def blocked_stop(*, expected_worker=None) -> None:
                stop_entered.set()
                await release_stop.wait()

            runtime._stop_worker = blocked_stop
            with patch("app.multiprocessing.get_context") as get_context:
                task = asyncio.create_task(runtime._start_worker())
                await stop_entered.wait()
                runtime._closing = True
                release_stop.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task

            get_context.assert_not_called()
            self.assertIsNone(runtime._worker)

        asyncio.run(scenario())

    def test_cancelled_inference_maps_to_http_499(self) -> None:
        runtime = Runtime(loader=FakeModel)

        async def cancelled(*args, **kwargs):
            raise InferenceCancelledError("cancelled")

        runtime.synthesize = cancelled
        with TestClient(create_app(runtime)) as client:
            response = client.post(
                "/v1/audio/speech",
                json={
                    "model": MODEL_ID,
                    "input": "请停止",
                    "voice": "Serena",
                    "response_format": "pcm",
                },
            )

        self.assertEqual(response.status_code, 499)
        self.assertEqual(response.json()["detail"], "TTS request was cancelled")


if __name__ == "__main__":
    unittest.main()
