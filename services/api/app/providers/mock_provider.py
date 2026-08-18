from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
import json

from app.models.domain import ProviderCapability
from app.providers.base import LLMProvider, ProviderMessage, ProviderStreamChunk


class MockLLMProvider(LLMProvider):
    name = "mock"

    async def generate_reply_stream(
        self,
        *,
        model: str,
        system_prompt: str,
        history: list[ProviderMessage],
        user_message: str,
    ) -> AsyncIterator[ProviderStreamChunk]:
        _ = system_prompt
        _ = history

        if model == "mock-analysis-v1":
            request_prefix = "请围绕这个主题输出完整的分步演示脚本："
            demo_topic = user_message.removeprefix(request_prefix).strip() or "当前主题"
            payload = {
                "title": f"{demo_topic[:100]} · 分步演示",
                "steps": [
                    {
                        "board": {
                            "kind": "markdown",
                            "content": "1. 明确问题\n2. 拆出关键变量\n3. 先看整体结构",
                        },
                        "caption": "先把问题拆成三块。",
                        "narration": "第一步先把题目里的目标、条件和对象拆开，这样后面的推导就不会乱。",
                    },
                    {
                        "board": {
                            "kind": "mermaid",
                            "content": "flowchart LR\nA[已知条件] --> B[关键关系]\nB --> C[结论]",
                        },
                        "caption": "把关系连成一条因果链。",
                        "narration": "第二步把条件之间的关系串起来，确定是哪一个条件推动了下一步。",
                    },
                    {
                        "board": {
                            "kind": "highlight",
                            "content": "这里决定最终结论。",
                            "target": "关键关系",
                        },
                        "caption": "最后标出真正决定结果的部分。",
                        "narration": "第三步只抓住最关键的连接点，再回头解释为什么它会导向最终答案。",
                    },
                ],
            }
        else:
            payload = {
                "display_text": (
                    "这是一个用于联调的本地模拟回复。"
                    "现在已经能走通角色化聊天、结构化响应和前端展示链路。"
                    "等你换成真实模型 key，就会切到更完整的对话体验。"
                ),
                "spoken_text": "这是一个用于联调的本地模拟回复。现在已经能走通角色化聊天、结构化响应和前端展示链路。",
                "emotion": "playful",
                "suggested_actions": ["继续追问", "换一个角色", "开始复盘"],
            }
            if any(keyword in user_message.lower() for keyword in ("画", "图", "board", "白板")):
                payload["board_actions"] = [
                    {
                        "kind": "markdown",
                        "content": "- 关键概念\n- 因果关系\n- 下一步问题",
                    }
                ]
        raw_text = json.dumps(payload, ensure_ascii=False)
        split_points = (19, 47, len(raw_text))
        offset = 0
        for index, end in enumerate(split_points):
            yield ProviderStreamChunk(
                text=raw_text[offset:end],
                input_tokens=max(len(user_message) // 4, 1),
                output_tokens=max(len(raw_text) // 4, 1) if index == len(split_points) - 1 else None,
            )
            offset = end

    async def discover_models(
        self,
        capability: ProviderCapability | None = None,
    ) -> list[str]:
        if capability is ProviderCapability.embedding:
            return ["mock-embedding-v1"]
        if capability in {
            ProviderCapability.chat_llm,
            ProviderCapability.analysis_llm,
            None,
        }:
            return ["mock-companion-v1", "mock-analysis-v1"]
        if capability is ProviderCapability.stt:
            return ["mock-stt-v1"]
        if capability is ProviderCapability.tts:
            return ["mock-voice-v1"]
        return []

    async def embed(
        self,
        *,
        model: str,
        texts: Sequence[str],
    ) -> list[list[float]]:
        _ = model
        return [
            [
                float(len(text) % 17) / 17.0,
                float(sum(text.encode("utf-8")) % 31) / 31.0,
                1.0,
            ]
            for text in texts
        ]

    async def transcribe_pcm16(
        self,
        model: str,
        pcm16: bytes,
        sample_rate_hz: int = 16000,
    ) -> str:
        _ = model
        _ = pcm16
        _ = sample_rate_hz
        return "这是一段用于联调语音链路的模拟转写。"

    async def synthesize_speech_stream(
        self,
        model: str,
        text: str,
        voice_id: str,
        speed: float = 1.0,
        sample_rate_hz: int = 24000,
    ) -> AsyncIterator[bytes]:
        _ = model
        _ = text
        _ = voice_id
        _ = speed
        pcm16 = bytearray()
        total_samples = max(sample_rate_hz * 2, 1)
        waveform = (0, 900, 1800, 900, 0, -900, -1800, -900)
        for index in range(total_samples):
            amplitude = waveform[index % len(waveform)]
            pcm16.extend(int(amplitude).to_bytes(2, byteorder="little", signed=True))

        chunk_size = 960
        for offset in range(0, len(pcm16), chunk_size):
            yield bytes(pcm16[offset : offset + chunk_size])
