// run-h3-batch.mjs —— 把 jobs.json 里的视频任务排进本机 ComfyUI（MiniMax H3-Base，首尾帧模式）。
//
// 节点图的来历：取自 2026-11-21 真正出片的那 24 段视频文件里内嵌的流程
// （F:\Codex\MiniMax-H3\output\TeacherBatch-20261120\segments\*.mp4 的元数据）：
//   UNETLoader → 8 步加速 LoRA → MiniMaxH3ImageToVideo(首帧、尾帧) → res_multistep / simple / 8 步
//   → VAEDecode → CreateVideo(24fps) → SaveVideo；需要声音时多一个音频 VAE 解码。
// "提交 → 等待 → 取回成片"这条链路参考了同机的 render.mjs，那个脚本自己没有跑完过一条。
// 所以：节点图是验证过的，这个脚本整体还没有连着真实的 ComfyUI 跑过——试产第 1 步就是验证它。
//
// 用法（先启动 ComfyUI：双击 F:\Codex\MiniMax-H3\Start-H3.cmd，等它监听 127.0.0.1:8188）：
//   node run-h3-batch.mjs --tutor chutang --slot idle_breathe --takes 1     先跑通一条
//   node run-h3-batch.mjs --pilot                                           试产：初棠 3 段 × 3 个种子
//   node run-h3-batch.mjs --tutor chutang --batch P0                        初棠的第一批
//   node run-h3-batch.mjs --tutor xuechuan,shenyan --batch P0               两位老师的第一批
//   node run-h3-batch.mjs --tutor all --batch P0                            六位老师的第一批
//   node run-h3-batch.mjs --tutor chutang --slot idle_breathe --takes 1 --no-turbo    20 步对照
//   node run-h3-batch.mjs --tutor chutang --batch P0 --profile small        跑不动 576x1024 时退回 480x864
//   加 --dry-run 只检查文件、打印将要提交的内容，不提交。
// 可以随时关掉再重跑：已经成功的会跳过；提示词改过的会自动重做（文件名里的 p 后缀不同）。
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = process.env.TUTORPACK_BATCH_DIR || dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(2);
}

// ── 参数 ──
const VALUE_FLAGS = new Set(["api", "comfy", "profile", "steps", "takes", "tutor", "batch", "slot"]);
const BOOL_FLAGS = new Set(["no-turbo", "dry-run", "pilot"]);
const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith("--")) fail(`看不懂的参数：${arg}`);
  const name = arg.slice(2);
  if (BOOL_FLAGS.has(name)) opts[name] = true;
  else if (VALUE_FLAGS.has(name)) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`--${name} 后面要跟一个值`);
    opts[name] = next;
    i += 1;
  } else fail(`没有这个参数：--${name}（可用：${[...VALUE_FLAGS, ...BOOL_FLAGS].map((f) => `--${f}`).join(" ")}）`);
}

const api = opts.api ?? "http://127.0.0.1:8188";
const comfy = opts.comfy ?? "F:\\Codex\\MiniMax-H3";
const profile = opts.profile ?? "medium";
const shape = { medium: [576, 1024], small: [480, 864] }[profile];
if (!shape) fail("--profile 只能是 medium（576x1024）或 small（480x864）");
const turbo = !opts["no-turbo"];
const steps = Number(opts.steps ?? (turbo ? 8 : 20));
if (!Number.isInteger(steps) || steps < 1 || steps > 60) fail("--steps 要是 1–60 的整数");
if (turbo && steps !== 8) fail("加速 LoRA 是按 8 步训练的；要用别的步数请同时加 --no-turbo");
const takes = Number(opts.takes ?? 3);
if (!Number.isInteger(takes) || takes < 1 || takes > 3) fail("--takes 只能是 1、2 或 3");
const dryRun = Boolean(opts["dry-run"]);
const pilot = Boolean(opts.pilot);
const slots = pilot ? ["idle_breathe", "speak_calm", "greet_wave"] : (opts.slot ?? "").split(",").filter(Boolean);
const tutors = (pilot ? "chutang" : opts.tutor ?? "").split(",").filter(Boolean);
if (!tutors.length) fail("请用 --tutor 指定老师（xuechuan shenyan lanyue chutang qingheng lanyin，可用逗号连接，或 all），或用 --pilot");
const batch = opts.batch ?? "";
if (!pilot && !batch && !slots.length) fail("请用 --batch 指定批次（P0 / P1 / P2），或用 --slot 指定片段。不指定会把 27 段全跑一遍。");
if (batch && !["P0", "P1", "P2", "all"].includes(batch)) fail("--batch 只能是 P0、P1、P2 或 all");

const jobs = JSON.parse(await readFile(join(here, "jobs.json"), "utf8"));
const folderOf = (job) => job.id.split("__")[0];            // 例如 04-chutang
const matchesTutor = (job) => tutors.some((t) => t === "all" || t === job.slug || t === folderOf(job) || t === folderOf(job).slice(0, 2));
const knownSlots = new Set(jobs.map((job) => job.slot));
for (const s of slots) if (!knownSlots.has(s)) fail(`没有这个片段：${s}`);
const selected = jobs.filter((job) => matchesTutor(job) &&
  (!batch || batch === "all" || job.batch === batch) &&
  (slots.length === 0 || slots.includes(job.slot)));
if (!selected.length) fail("没有匹配的任务，请检查 --tutor / --batch / --slot 的拼写");

const runsDir = join(here, "runs");
const events = join(runsDir, "renders.jsonl");
await mkdir(runsDir, { recursive: true });

const tag = `${shape[0]}x${shape[1]}${turbo ? "" : `-full-st${steps}`}`;
const revOf = (job) => job.prompt_rev ?? createHash("sha1").update(`${job.prompt}|${job.length}`).digest("hex").slice(0, 6);
const sized = (name) => name.replace(/^hub\//, "").replace(/-\d+x\d+\.png$/, `-${shape[0]}x${shape[1]}.png`);
const inputName = (name) => `tutormedia-${sized(name)}`;
const outName = (job, seed) => `${job.id}__s${seed}__${tag}__p${revOf(job)}.mp4`;
const keyOf = (job, seed) => `${job.id}|${seed}|${tag}|${revOf(job)}`;

function graph(job, seed) {
  const [width, height] = shape;
  const node = (class_type, inputs) => ({ class_type, inputs });
  const model = turbo ? ["2", 0] : ["1", 0];
  const sameFrame = job.last_frame === job.first_frame;
  const workflow = {
    "1": node("UNETLoader", { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" }),
    "3": node("CLIPLoader", { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" }),
    "4": node("VAELoader", { vae_name: "minimax_h3_video_vae_int8_convrot.safetensors" }),
    "6": node("MiniMaxH3ImageToVideo", { clip: ["3", 0], vae: ["4", 0], first_frame: ["16", 0], last_frame: sameFrame ? ["16", 0] : ["19", 0],
      width, height, length: job.length, prompt: job.prompt }),
    "7": node("RandomNoise", { noise_seed: seed }),
    "8": node("BasicGuider", { model, conditioning: ["6", 0] }),
    "9": node("KSamplerSelect", { sampler_name: "res_multistep" }),
    "10": node("BasicScheduler", { model, scheduler: "simple", steps, denoise: 1 }),
    "11": node("SamplerCustomAdvanced", { noise: ["7", 0], guider: ["8", 0], sampler: ["9", 0], sigmas: ["10", 0], latent_image: ["6", 1] }),
    "12": node("VAEDecode", { samples: ["11", 0], vae: ["4", 0] }),
    "14": node("CreateVideo", { images: ["12", 0], fps: 24 }),
    "15": node("SaveVideo", { video: ["14", 0], filename_prefix: `TutorMedia-20261122/raw/${job.id}__s${seed}__${tag}__p${revOf(job)}`,
      format: "auto", "format.codec": "auto", codec: "auto" }),
    "16": node("LoadImage", { image: inputName(job.first_frame) }),
  };
  if (turbo) {
    workflow["2"] = node("LoraLoaderModelOnly", { model: ["1", 0], lora_name: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", strength_model: 1 });
  }
  if (!sameFrame) workflow["19"] = node("LoadImage", { image: inputName(job.last_frame) });
  if (job.keep_audio) {
    workflow["5"] = node("VAELoader", { vae_name: "minimax_h3_audio_vae_fp32.safetensors" });
    workflow["13"] = node("VAEDecodeAudio", { samples: ["11", 0], vae: ["5", 0] });
    workflow["14"].inputs.audio = ["13", 0];
  }
  return workflow;
}

async function request(path, options) {
  const response = await fetch(api + path, { ...options, signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${JSON.stringify(data).slice(0, 3000)}`);
  return data;
}

async function record(data) {
  await appendFile(events, JSON.stringify({ at: new Date().toISOString(), ...data }) + "\n", "utf8");
  console.log(JSON.stringify(data));
}

async function history() {
  const text = await readFile(events, "utf8").catch((err) => { if (err.code === "ENOENT") return ""; throw err; });
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  // 1. 列出要做的，检查首尾帧图片
  const work = [];
  for (const job of selected) for (const seed of job.seeds.slice(0, takes)) work.push({ job, seed });
  const frames = work.reduce((sum, w) => sum + w.job.length, 0);
  console.log(`选中 ${work.length} 条（${selected.length} 段 × ${takes} 个种子），${shape[0]}x${shape[1]}，${turbo ? "加速 8 步" : `完整 ${steps} 步`}，合计 ${frames} 帧。`);
  const hubNames = new Set(selected.flatMap((job) => [sized(job.first_frame), sized(job.last_frame)]));
  for (const name of hubNames) {
    const source = join(here, "hub", name);
    await stat(source).catch(() => fail(`找不到首尾帧图片：${source}`));
    if (!dryRun) {
      await mkdir(join(comfy, "input"), { recursive: true });
      await copyFile(source, join(comfy, "input", `tutormedia-${name}`));
    }
  }
  if (dryRun) {
    const { job, seed } = work[0];
    console.log(`第一条的成片会叫：${outName(job, seed)}`);
    console.log("第一条将提交的内容：");
    console.log(JSON.stringify(graph(job, seed), null, 1).slice(0, 2400));
    console.log("（--dry-run：没有提交任何任务）");
    return;
  }

  // 2. 确认 ComfyUI 在运行
  await request("/queue").catch(() => fail(`连不上 ${api}。请先双击 ${comfy}\\Start-H3.cmd，等窗口里出现 127.0.0.1:8188 之后再运行。`));

  // 3. 逐条提交、等待、把成片复制回素材包
  let done = 0, skipped = 0, consecutiveFailures = 0;
  const failed = [];
  for (const { job, seed } of work) {
    const key = keyOf(job, seed);
    const rows = (await history()).filter((row) => row.key === key);
    if (rows.some((row) => row.state === "success")) { skipped += 1; continue; }
    let promptId = null;
    const last = rows.at(-1);
    if (last?.state === "queued") {
      promptId = last.promptId;
      const finished = await request(`/history/${promptId}`);
      const queue = await request("/queue");
      if (!finished[promptId] && ![...queue.queue_running, ...queue.queue_pending].some((row) => row[1] === promptId)) {
        await record({ key, state: "lost", promptId });
        promptId = null;
      }
    }
    if (!promptId) {
      const data = await request("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph(job, seed), client_id: "tutor-media-20261122" }) });
      if (!data.prompt_id) throw new Error(JSON.stringify(data).slice(0, 2000));
      promptId = data.prompt_id;
      await record({ key, state: "queued", promptId });
    }
    let result;
    let misses = 0;
    const deadline = Date.now() + 90 * 60 * 1000;
    while (!result) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 15000));
      try {
        result = (await request(`/history/${promptId}`))[promptId];
        misses = 0;
      } catch (err) {
        misses += 1;
        if (misses > 20) throw err;      // 连续 5 分钟问不到，才认为服务没了
      }
    }
    const file = result?.outputs?.["15"]?.images?.[0];
    if (!result || !file || result.status?.status_str !== "success") {
      const issue = result?.status?.messages?.find((msg) => msg[0] === "execution_error")?.[1];
      const message = !result ? "超过 90 分钟没有完成" : issue?.exception_message?.slice(0, 1800) || result.status?.status_str || "没有产出文件";
      await record({ key, state: "error", promptId, node: issue?.node_type, message });
      failed.push(key);
      consecutiveFailures += 1;
      if (/out of memory|OutOfMemory|Allocation on device/i.test(message)) {
        console.error("这一条是显存不够。可以改用小尺寸重跑：在命令后面加 --profile small。");
      }
      if (consecutiveFailures >= 2) {
        console.error("连续两条失败，先停下。请把上面的两行 error 发给方案作者或 Codex。");
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
    const target = join(here, "回传", folderOf(job));
    await mkdir(join(target, "选中"), { recursive: true });
    await copyFile(join(comfy, "output", file.subfolder ?? "", file.filename), join(target, outName(job, seed)));
    const started = result.status?.messages?.find((msg) => msg[0] === "execution_start")?.[1]?.timestamp;
    const finishedAt = result.status?.messages?.find((msg) => msg[0] === "execution_success")?.[1]?.timestamp;
    await record({ key, state: "success", promptId, file: outName(job, seed),
      renderSeconds: started && finishedAt ? (finishedAt - started) / 1000 : null });
    done += 1;
  }
  console.log(`这一轮：新完成 ${done} 条，跳过已完成的 ${skipped} 条，失败 ${failed.length} 条。`);
  if (failed.length) {
    console.log(`失败的：\n  ${failed.join("\n  ")}\n重跑同一条命令会再试这些。`);
    process.exitCode = 1;
  } else {
    console.log("成片在「回传」文件夹里；挑中的请拖进其中的「选中」。");
  }
}

main().catch((err) => {
  console.error(`脚本中断了：${err?.message ?? err}`);
  console.error("如果是连不上 ComfyUI：确认 Start-H3.cmd 的窗口还开着，然后重跑同一条命令（已完成的会跳过）。");
  process.exitCode = 1;
});
