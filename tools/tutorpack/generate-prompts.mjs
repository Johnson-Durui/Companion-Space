// generate-prompts.mjs
// 生成六位老师的图片提示词（OpenAI Images 2.6）与视频提示词（MiniMax H3-Base，首尾帧模式 FL2VA）。
//
// 用法（在素材包根目录执行）：
//   node 03-给Codex/generate-prompts.mjs .
//
// 改提示词时请改这里的"角色数据"和"模板"，再重新运行；不要手改生成出来的文件。
//
// 视频提示词遵循 MiniMax 官方的《Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA)》：
//   第一行是固定的首尾帧对齐句，空一行，然后是三个字段；正文用英文，台词放在 <d>[Chinese] …</d> 里；
//   单镜头，不写时间区间。本地模型没有负向提示：写出来的东西都会被当成"要出现的东西"，
//   所以这里不写"禁止清单"，也不点名画面外的物件（白板、桌子、纸笔），只描述画面里看得见的变化。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const outRoot = process.argv[2] ?? ".";
const IMG_DIR = join(outRoot, "01-图片提示词");
const VID_DIR = join(outRoot, "02-视频提示词");
mkdirSync(IMG_DIR, { recursive: true });
mkdirSync(VID_DIR, { recursive: true });

// 生成画幅：576x1024 是 32 的整数倍里唯一贴近现有素材的精确 9:16（备用 480x864）。
const CANVAS = { width: 576, height: 1024 };
const FPS = 24;
const seconds = (frames) => (frames / FPS).toFixed(2);

// ───────────────────────────── 角色数据 ─────────────────────────────
// 方位一律按"画面上的左右"（viewer's left / right），不按角色自己的左右。
// handSide：单手动作从画面哪一侧抬起——选在没有小配饰的那一侧，免得手挡住胸针、刺绣、发饰之后模型把它们画错。
const TUTORS_DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), "tutors-data.json");
const TUTORS = JSON.parse(readFileSync(TUTORS_DATA_PATH, "utf8"));

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
for (const t of TUTORS) { t.Subj = cap(t.subj); t.Poss = cap(t.poss); }

// ───────────────────────────── 视频：片段目录 ─────────────────────────────
const arms = (t) => `${t.Poss} arms rest relaxed at ${t.poss} sides, as in Picture 1.`;
const HANDS = {
  one: "The hand is drawn cleanly with five natural fingers.",
  two: "Both hands are drawn cleanly with five natural fingers each.",
  fist: "The hand is drawn cleanly as a closed fist.",
  thumb: "The hand is drawn cleanly as a closed fist with the thumb up.",
};
const handsLine = (t, kind) => (kind === "none" ? arms(t) : HANDS[kind]);

// 官方写法：把音色描述挂在画面里这个人自己的名词短语上，再跟 (S1)。
const say = (t, line) =>
  `The ${t.voice.replace(/^an? /, "")} (S1) says: <d>[Chinese] ${line}</d> ${t.Poss} mouth moves in small, relaxed shapes with each syllable and closes softly after the last word.`;

const SOUND = {
  silent: "Quiet indoor room tone with a faint, soft rustle of fabric.",
  speak: "Quiet indoor room tone with a faint rustle of fabric.",
  claps: "Quiet indoor room tone with a few soft, light hand claps and a faint rustle of fabric.",
  intro: "Quiet, dry indoor room tone.",
};

const SLOTS = [
  // ── 第一批（P0）──
  { id: "idle_breathe", zh: "待机呼吸（重做）", kind: "loop", frames: 158, batch: "P0", mouth: "closed",
    when: "没在讲、没在听的所有空档。出现次数最多的一段。",
    check: "全程闭嘴；只有呼吸和两次眨眼；不点头、不挥手、不露牙；结尾和开头一模一样。",
    action: (t) => `${t.Subj} sits calmly and simply breathes: ${t.poss} shoulders and chest rise and fall slowly two times, ${t.subj} blinks softly twice at an easy pace, and ${t.poss} head drifts by a tiny amount and settles again. ${t.Poss} eyes stay warmly on the viewer the whole time. ${arms(t)} Loose hair ends and fabric move only slightly with the breathing.` },
  { id: "idle_glance", zh: "待机 · 看一眼别处", kind: "loop", frames: 158, batch: "P0", mouth: "closed",
    when: "待机时每隔十几秒穿插一次，打破\"一直盯着你\"的感觉。",
    check: "眼睛先动、头只跟着微转；看的是画面右侧；看完回到正面；全程闭嘴。",
    action: (t) => `After one calm breath, ${t.poss} eyes drift toward ${t.glance} and ${t.poss} head follows by a few degrees; ${t.subj} rests ${t.poss} gaze there for a moment with a small private smile, blinks once, then brings ${t.poss} eyes and head smoothly back to the viewer. ${arms(t)}` },
  { id: "listen_nod", zh: "倾听点头（重做）", kind: "loop", frames: 124, batch: "P0", mouth: "closed",
    when: "学生在说话或打字的时候。",
    check: "两次小而清楚的点头；眼睛一直看着你；闭嘴；不是只眨一下眼。",
    action: (t) => `${t.Subj} leans forward very slightly and listens attentively with ${t.poss} eyes on the viewer; ${t.subj} gives two small, clear nods with a short pause between them, blinks once, and eases back upright. ${arms(t)}` },
  { id: "wait_gentle", zh: "耐心等你回答", kind: "loop", frames: 158, batch: "P0", mouth: "closed",
    when: "老师提问之后、等学生作答的时候。",
    check: "不催、不盯：中间有一次垂眼再抬眼；表情是鼓励；闭嘴。",
    action: (t) => `${t.Subj} waits patiently, giving the viewer time to think: ${t.subj} breathes slowly, blinks softly and looks at the viewer with a gentle, encouraging smile; then ${t.poss} gaze lowers for a moment, and ${t.subj} looks up at the viewer again with the same calm smile. ${arms(t)}` },
  { id: "speak_calm", zh: "平静讲解（默认讲话）", kind: "loop", frames: 124, batch: "P0", mouth: "speak", sound: "speak",
    line: "先看已知条件，再一步步往下推。",
    when: "老师出声时最常用的一段。",
    check: "嘴小幅开合、不露一口大牙；头和眉毛有自然微动；画面里没有手；说完嘴闭上。",
    action: (t, s) => `${t.Subj} speaks to the viewer while sitting almost still, with small natural movements of the head and eyebrows that follow the words. ${say(t, s.line)} ${arms(t)}` },
  { id: "speak_explain_a", zh: "讲解 · 单手示意（重做）", kind: "loop", frames: 124, batch: "P0", mouth: "speak", sound: "speak",
    line: "这里是关键，抓住它就顺了。",
    when: "讲到要点时，与\"平静讲解\"轮换。",
    check: "只有一只手，掌心向上，在胸口偏下；五根手指正常；嘴型不夸张；说完手收回画外。",
    action: (t, s) => `${t.Subj} speaks to the viewer and, as ${t.subj} begins, raises one hand into the frame ${t.handSide} at lower-chest height with the palm open and turned upward; the hand moves gently once or twice to underline the point. ${say(t, s.line)} As the last word ends, the hand lowers out of the bottom of the frame. ${HANDS.one}` },
  { id: "prepare_notes", zh: "备课中", kind: "loop", frames: 192, batch: "P0", mouth: "closed",
    when: "候课界面显示\"正在备课\"的那一分钟。",
    check: "垂眼往画面下方看，像在看桌上的东西；肩膀有规律的小动作；最后抬头看你、微笑；画面里没有手和纸笔。",
    action: (t) => `${t.Subj} lowers ${t.poss} eyes and inclines ${t.poss} head slightly, looking down past the bottom edge of the frame in quiet concentration; one shoulder and upper arm shift in small, regular movements; ${t.subj} pauses, gives a tiny nod, looks down a moment longer, then lifts ${t.poss} head, looks at the viewer and smiles.` },
  { id: "greet_wave", zh: "上课问候", kind: "oneshot", frames: 124, batch: "P0", mouth: "smile",
    when: "点\"开始上课\"的一刻；老师页里选中这位老师时。",
    check: "动作符合这位老师的气质；手指正常；做完手收回画外。",
    action: (t) => `${t.greet} ${handsLine(t, t.greetHands)}` },
  { id: "farewell_wave", zh: "下课道别", kind: "oneshot", frames: 124, batch: "P0", mouth: "smile",
    when: "点\"下课\"之后，小结出来之前。",
    check: "看得出是在道别，和问候不是同一个动作；手指正常。",
    action: (t) => `${t.farewell} ${handsLine(t, t.farewellHands)}` },

  // ── 第二批（P1）──
  { id: "idle_fidget", zh: "待机 · 个人小习惯", kind: "loop", frames: 158, batch: "P1", mouth: "closed",
    when: "待机时偶尔出现，大约一分钟一次。",
    check: "是这位老师独有的小习惯；幅度小；闭嘴；没有手。",
    action: (t) => `${t.fidget} ${arms(t)}` },
  { id: "listen_tilt", zh: "倾听 · 歪头", kind: "loop", frames: 124, batch: "P1", mouth: "closed",
    when: "倾听时与\"点头\"轮换。",
    check: "歪头、微微挑眉、一次点头；闭嘴。",
    action: (t) => `${t.Subj} tilts ${t.poss} head a few degrees to one side and raises ${t.poss} eyebrows slightly, listening closely; ${t.subj} gives one small encouraging nod, then straightens ${t.poss} head again. ${arms(t)}` },
  { id: "think_gaze", zh: "思考 · 抬眼", kind: "loop", frames: 124, batch: "P1", mouth: "closed",
    when: "状态显示\"在想\"的时候。",
    check: "眼睛看向画面左上；没有手；最后像是想到了，微笑看回你。",
    action: (t) => `${t.Subj} looks up toward the upper left of the frame, thinking: ${t.poss} eyebrows draw together slightly and ${t.poss} head tilts a few degrees; ${t.subj} blinks slowly once, then ${t.poss} eyes return to the viewer and a small smile appears, as the idea arrives. ${arms(t)}` },
  { id: "think_chin", zh: "思考 · 托腮（重做）", kind: "loop", frames: 141, batch: "P1", mouth: "closed",
    when: "\"在想\"时与\"抬眼\"轮换。",
    check: "食指轻点下巴旁；五指正常；手从画面下方进来、原路收回。",
    action: (t) => `${t.Subj} raises one hand into the frame ${t.handSide} and rests the index fingertip lightly beside ${t.poss} chin, tilting ${t.poss} head a few degrees; ${t.poss} eyes look up for a moment in thought and then return to the viewer with a small smile; the hand lowers smoothly out of the bottom of the frame. ${HANDS.one}` },
  { id: "read_answer", zh: "看你的答案", kind: "loop", frames: 124, batch: "P1", mouth: "closed",
    when: "学生提交答案后、判定出来之前。",
    check: "垂眼；目光从左到右移动两次；点一下头；抬眼看你。",
    action: (t) => `${t.Subj} lowers ${t.poss} eyes and inclines ${t.poss} head slightly, looking down past the bottom edge of the frame and reading with care: ${t.poss} eyes travel from left to right twice, ${t.subj} gives one small thoughtful nod, then looks back up at the viewer. ${arms(t)}` },
  { id: "speak_explain_b", zh: "讲解 · 列举三点（重做）", kind: "loop", frames: 141, batch: "P1", mouth: "speak", sound: "speak",
    line: "第一步，第二步，第三步，按顺序来。",
    when: "讲步骤或并列内容的时候。",
    check: "一只手在胸前点三下；五指正常；嘴型不夸张。",
    action: (t, s) => `${t.Subj} speaks to the viewer and raises one open hand into the frame ${t.handSide} at lower-chest height, tapping the air three times in a row, as if setting three points side by side. ${say(t, s.line)} As the last word ends, the hand lowers out of the bottom of the frame. ${HANDS.one}` },
  { id: "speak_board", zh: "讲解 · 带着看白板", kind: "loop", frames: 141, batch: "P1", mouth: "speak", sound: "speak",
    line: "看这里，这一行就是那个关系。",
    when: "板书正在出现，或老师正指着板书讲的时候。",
    check: "眼睛和头转向画面右侧（转头很小）；画面右侧的一只手掌心朝右；说完看回你。",
    action: (t, s) => `${t.Subj} speaks while guiding attention toward the right side: ${t.poss} eyes and head turn a few degrees toward the right edge of the frame, and one open hand rises into the frame at the viewer's right at lower-chest height, the palm turned toward that side. ${say(t, s.line)} As the last word ends, ${t.subj} looks back at the viewer and the hand lowers out of the bottom of the frame. ${HANDS.one}` },
  { id: "board_point", zh: "指白板（重做）", kind: "oneshot", frames: 124, batch: "P1", mouth: "smile",
    when: "老师没在出声时，指向板书的某一处。",
    check: "食指指向画面右侧；转头幅度小；手指正常；做完看回你。",
    action: (t) => `${t.Poss} eyes and head turn a few degrees toward the right edge of the frame; ${t.subj} raises one hand into the frame at the viewer's right at lower-chest height and points with the index finger toward the right edge, holds the gesture for a moment with an inviting smile, then lowers the hand out of the bottom of the frame and looks back at the viewer. ${HANDS.one}` },
  { id: "board_glance", zh: "看一眼白板", kind: "oneshot", frames: 124, batch: "P1", mouth: "closed",
    when: "老师没在出声时，白板上写出了新内容。",
    check: "只动眼睛和头；没有手；一次小点头。",
    action: (t) => `${t.Poss} eyes move toward the right edge of the frame and ${t.poss} head follows by a few degrees; ${t.subj} gives one small nod toward that side, holds the look for a moment, then looks back at the viewer. ${arms(t)}` },
  { id: "react_praise", zh: "答对 · 点赞（可重做）", kind: "oneshot", frames: 124, batch: "P1", mouth: "smile",
    when: "学生答对。",
    check: "竖大拇指清楚；笑得开心但符合人设。",
    action: (t) => `${t.praise ?? `${t.Poss} eyes curve into a happy smile; ${t.subj} raises one hand into the frame ${t.handSide} at lower-chest height in a clear thumbs-up, gives one glad nod, then lowers the hand out of the bottom of the frame as the smile softens.`} ${HANDS.thumb}` },
  { id: "react_clap", zh: "答对 · 鼓掌", kind: "oneshot", frames: 124, batch: "P1", mouth: "smile", sound: "claps",
    when: "答对时与\"点赞\"轮换。",
    check: "两只手，轻拍三下；十根手指正常；拍完收回。",
    action: (t) => `${t.clapFace ?? `${t.Poss} eyes curve with delight`}; ${t.subj} raises both hands into the lower part of the frame and claps lightly three times, then lowers both hands out of the bottom of the frame. ${HANDS.two}` },
  { id: "react_comfort", zh: "答错 · 安抚（可重做）", kind: "oneshot", frames: 124, batch: "P1", mouth: "smile",
    when: "学生答错，或点了\"没听懂\"。",
    check: "身体微微前倾，慢慢点一次头，一只手掌心向上；神情是关心，不是失望。",
    action: (t) => `${t.Poss} expression softens into a caring, reassuring look; ${t.subj} leans forward very slightly, nods slowly once and raises one hand into the frame ${t.handSide} at lower-chest height with the palm open and turned upward in a calm, offering gesture, then lowers the hand out of the bottom of the frame. ${HANDS.one}` },
  { id: "react_encourage", zh: "加油", kind: "oneshot", frames: 124, batch: "P1", mouth: "smile",
    when: "学生准备再试一次之前。",
    check: "活泼的老师是小拳头轻轻一握；稳重的老师是看着你、笃定地点一下头。",
    action: (t) => (t.encourage
      ? `${t.encourage.text} ${handsLine(t, t.encourage.hands)}`
      : `${t.Subj} raises one hand into the frame ${t.handSide} at lower-chest height as a small closed fist and gives it one short, firm pump with a determined, encouraging smile and a nod, then lowers the hand out of the bottom of the frame. ${HANDS.fist}`) },
  { id: "react_celebrate", zh: "下课庆祝", kind: "oneshot", frames: 141, batch: "P1", mouth: "smile", sound: "claps",
    when: "课后小结出现的时候。",
    check: "比点赞更开心；仍然符合这位老师的气质；双手正常。",
    action: (t) => `${t.celebrate} ${HANDS.two}` },
  { id: "hint_finger", zh: "给个提示", kind: "oneshot", frames: 124, batch: "P1", mouth: "smile",
    when: "学生点\"给点提示\"。",
    check: "食指轻点太阳穴/眉梢外侧（灵光一闪），轻微歪头、眼神看着你、会意闭嘴微笑；手指正常。",
    action: (t) => (t.handSide.endsWith("right")
      ? `She raises her own left hand gently into the frame on the screen-right arched-window side, well inside the right border of the picture, and touches her index fingertip lightly beside her temple below her horn, giving one gentle tap in a knowing hint gesture as she tilts her head a few degrees with a warm closed-lip smile while keeping her eyes warmly on the viewer; her right arm on the purple-hair-ornament side stays relaxed at her side, and both pearl-white horns and the collar teardrop pendant remain clearly visible; she holds the knowing smile for a moment, then lowers her left hand smoothly out of the bottom of the frame. ${HANDS.one}`
      : `${t.Subj} raises one hand into the frame at the viewer's left and touches the index fingertip lightly beside ${t.poss} temple, giving one gentle tap in a knowing hint gesture as ${t.subj} tilts ${t.poss} head a few degrees with a warm closed-lip smile while keeping ${t.poss} eyes warmly on the viewer; ${t.subj} holds the knowing smile for a moment, then lowers the hand smoothly out of the bottom of the frame. ${HANDS.one}`) },
  { id: "nod_yes", zh: "嗯，收到", kind: "oneshot", frames: 124, batch: "P1", mouth: "closed",
    when: "学生发来一句话、或做了确认的时候。",
    check: "一次干脆的点头；点头前后是安静的呼吸，没有别的动作。",
    action: (t) => `${t.Subj} holds the viewer's gaze for one calm breath, gives one clear, confirming nod with a brief warm smile and a soft blink, and rests still again, breathing quietly. ${arms(t)}` },

  // ── 第三批（P2）──
  { id: "react_surprise", zh: "惊喜", kind: "oneshot", frames: 124, batch: "P2", mouth: "smile",
    when: "学生答得很快，或连续答对。",
    check: "眼睛先睁大，再笑开；没有手。",
    action: (t) => `${t.surprise ?? `${t.Poss} eyes widen and ${t.poss} eyebrows lift in pleasant surprise, and ${t.poss} head draws back by a tiny amount; then ${t.poss} smile deepens and ${t.subj} gives one small nod.`} ${arms(t)}` },
  { id: "intro_voice", zh: "自我介绍（带声音，试验）", kind: "oneshot", frames: 192, batch: "P2", mouth: "speak", sound: "intro", audio: true, lead: 1.2,
    line: (t) => t.introLine,
    when: "试验用：老师页里选中这位老师时播放。默认不进产品（见手册\"决定 3\"）。",
    check: "口型和声音对得上；声音符合人设；只说这一句；说完微笑。",
    action: (t, s) => `${t.Subj} inclines ${t.poss} head in a brief greeting, then looks at the viewer and introduces ${t.self}. ${say(t, s.line(t))} After the last word ${t.subj} smiles warmly at the viewer. ${arms(t)}` },
];

const MOUTH = {
  closed: (t) => `${t.Poss} lips stay gently closed in a soft smile for the whole clip and ${t.subj} stays silent.`,
  smile: (t) => (t.closedSmile
    ? `${t.Poss} lips stay closed in the smile and ${t.subj} stays silent.`
    : `${t.Poss} lips stay together or part only slightly in the smile, and ${t.subj} stays silent.`),
  speak: () => "",
};

const lineOf = (t, s) => (typeof s.line === "function" ? s.line(t) : s.line);

// 针对单角色局部补拍的精准覆写（确保仅改动对应槽位哈希，零影响其余已过审槽位）。
const SLOT_OVERRIDES = {
  "lanyue:speak_explain_b": {
    action: (t, s) =>
      `She speaks to the viewer while sitting front-facing. Her own left forearm, on the screen-right arched-window side, rises gently into the right half of the frame at lower-chest height, near two-thirds of the picture width with an open strip of space between the hand and the right frame edge. Only her left hand appears; her right arm on the purple-hair-ornament side stays relaxed at her side. With her left hand held low at chest height and the five relaxed fingers angled gently downward and inward toward the center, she makes three small, measured downward wrist beats in a row to mark three steps side by side. The collar teardrop pendant stays clearly visible above and to the left of her hand. ${say(t, s.line)} As the last word ends, her lips close softly and her left hand lowers smoothly out of the bottom of the frame. ${HANDS.one}`,
  },
  "lanyue:react_comfort": {
    action: () =>
      `Her expression softens into a caring, reassuring look; she leans forward very slightly and nods slowly once. Her own left arm, on the screen-right arched-window side, bends gently inward so her left wrist rises into the right half of the frame at lower-chest height, near two-thirds of the picture width with an open strip of space separating the entire hand from the right frame edge. Only her left hand appears, opening softly palm-up with five gently curved fingers angled slightly inward toward the center in a calm, offering gesture. Her elbow stays close to her body, her right arm on the purple-hair-ornament side stays relaxed at her side, and the collar teardrop pendant stays clearly visible above and to the left of her hand. She holds the comforting gesture for a moment, then smoothly lowers her left hand out of the bottom of the frame. ${HANDS.one}`,
  },
  "lanyue:react_surprise": {
    action: (t) =>
      `Her lilac eyes brighten and widen softly and her eyebrows lift in quiet, delighted wonder while her lips stay gently and firmly closed together in a serene closed-lip smile; her head draws back by a tiny amount, then her eyes curve warmly in the same closed-lip smile and she gives one small nod. ${arms(t)}`,
    music: "Soft, quiet solo harp melody.",
  },
  "lanyin:think_gaze": {
    action: (t) =>
      `She glances thoughtfully up toward the upper left of the frame with a calm, composed expression: her eyebrows stay smooth, relaxed and level and her head tilts a few degrees; her lips stay gently and firmly closed in a serene resting line for the entire clip; she blinks calmly once, then brings her eyes smoothly back to the viewer with a crisp, knowing closed-lip smile as the answer clicks. ${arms(t)}`,
    music: "Soft, quiet solo electric piano chords.",
  },
};

function videoPrompt(t, s) {
  const override = SLOT_OVERRIDES[`${t.slug}:${s.id}`];
  const align = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${seconds(s.frames)}-second mark of the target video.`;
  const opening = `[Shot 1] ${t.style}, a vertical half-length medium shot of ${t.who}, seated facing the camera in ${t.room}, exactly as established by Picture 1. The camera holds a static shot at eye level for the whole clip, and the room behind ${t.obj} stays perfectly still. ${t.locks}.`;
  const actionText = override?.action ? override.action(t, s) : s.action(t, s);
  const parts = [opening, actionText, t.manner, MOUTH[s.mouth](t),
    `Well before the end ${t.subj} is still again, and the clip finishes in the exact pose, expression, framing and lighting established by Picture 2.`];
  const sound = SOUND[s.sound ?? "silent"];
  const music = override?.music ?? "N/A";
  return `${align}\n\nintegrated_multimodal_description: ${parts.filter(Boolean).join(" ")}\n\noverall_soundscape: ${sound}\n\nnon_diegetic_music: ${music}`;
}

// ───────────────────────────── 图片：任务目录 ─────────────────────────────
const KEEP_BASE = (t, posture, framing, tail) => `the same adult character as in Image 1 — face shape and features, eye color, hairstyle and hair color, ${t.imgLocks}, the complete outfit, body proportions and ${posture}; the same eye-level, straight-on camera, the same distance, crop and framing with ${framing}; ${tail}; the same line art and shading style`;
const SAME_LIGHT = "the same background with every object in the same place; the same light direction, exposure, white balance and color palette";
const KEEP = {
  face: (t) => KEEP_BASE(t, "the seated posture", "the head at the same size and position", SAME_LIGHT),
  arm: (t) => KEEP_BASE(t, "the seated posture of the torso and the other arm", "the head at the same size and position", SAME_LIGHT),
  head: (t) => KEEP_BASE(t, "the seated posture of the torso and both arms", "the shoulders at the same position", SAME_LIGHT),
  headArm: (t) => KEEP_BASE(t, "the seated posture of the torso and the other arm", "the shoulders at the same position", SAME_LIGHT),
  relight: (t) => KEEP_BASE(t, "the seated posture and expression", "the head at the same size and position", "the same room with every object in the same place"),
};
const HANDS_NONE = "both hands stay out of frame below the bottom edge, as in Image 1.";
const AVOID = "text, letters, watermark, logo, signature, border, UI elements, additional people, additional hands. This is an original character; do not imitate any existing franchise, studio or artist.";

function editPrompt(t, change, hands, keep = "face") {
  const lines = [
    "Use case: identity-preserving edit of an existing character portrait for a tutoring app.",
    "Input images: Image 1 is the approved portrait of this original character and is the edit target.",
    `Change only: ${change}`,
    `Keep unchanged: ${KEEP[keep](t)}.`,
    `Character (for reference only; do not redesign): ${t.dna}`,
  ];
  if (keep !== "relight") lines.push(`Lighting (as in Image 1): ${t.light}.`);
  lines.push("Composition: full-bleed vertical 9:16 with no border; same framing as Image 1.", `Hands: ${hands}`, `Avoid: ${AVOID}`);
  return lines.join("\n");
}

const IMAGE_JOBS = [
  { id: "expr_cheerful", zh: "开心", batch: "P0", use: "课后小结、答对、今天页白天的问候",
    check: "眼睛弯成月牙但仍然睁着；笑得比原图明显；其余完全没变。",
    prompt: (t) => editPrompt(t, t.closedSmile
      ? "the expression. Make it a clearly pleased, warm smile with the lips closed: the eyes narrow gently with warmth and the corners of the mouth lift higher than in Image 1. The head stays level and the gaze stays on the viewer."
      : "the expression. Make it a bright, happy smile: the lower eyelids rise so that both eyes narrow into soft crescents while staying open with the irises visible, the cheeks lift, and the mouth opens slightly in a warm smile that shows only a hint of the upper teeth. The head stays level and the gaze stays on the viewer.", HANDS_NONE) },
  { id: "expr_caring", zh: "关心", batch: "P0", use: "出错提示、答错之后、断网等坏消息",
    check: "眉头内侧微微上扬、眼神变柔和；是关心不是难过；头没有动。",
    prompt: (t) => editPrompt(t, "the expression. Make the look gentle and reassuring: the inner ends of the eyebrows lift slightly, the eyes soften and the smile is small and closed. The head stays level and the gaze stays on the viewer.", HANDS_NONE) },
  { id: "expr_curious", zh: "好奇", batch: "P0", use: "空状态（\"还没有课程\"）、提问时、访谈时",
    check: "眉毛微抬、眼睛更亮；闭嘴微笑；头没有动。",
    prompt: (t) => editPrompt(t, "the expression. Make the look curious and attentive: the eyebrows rise slightly, the eyes open a little wider and brighter, and the lips stay closed in a small interested smile. The head stays level and the gaze stays on the viewer.", HANDS_NONE) },
  { id: "expr_focused", zh: "专注", batch: "P0", use: "解锁页、练习与模考、\"正在整理\"之类的等待",
    check: "眉毛放平、眼神稳；嘴闭着、几乎不笑；不凶。",
    prompt: (t) => editPrompt(t, "the expression. Make it calm and focused: eyebrows level, eyes steady on the viewer, lips closed and relaxed with only a trace of a smile. The head stays level.", HANDS_NONE) },
  { id: "expr_playful", zh: "俏皮", batch: "P0", use: "404 页、轻松的小提示",
    check: "活泼的老师是眨一只眼；稳重的老师是挑一边眉、会意一笑。",
    prompt: (t) => editPrompt(t, t.closedSmile
      ? "the expression. Make it quietly amused: one eyebrow lifts slightly and the lips form a knowing closed half-smile; both eyes stay open on the viewer. The head stays level."
      : "the expression. Make it playful: the eye at the viewer's right closes in a light wink, the other eye stays open and bright, and the lips form a small closed grin. The head stays level.", HANDS_NONE) },
  { id: "expr_thinking", zh: "思考（有手）", batch: "P0", use: "加载中、\"在想\"的静态档；也是进阶里\"保持托腮\"的关键帧",
    check: "只有一只手；食指在下巴旁；五根手指正常；眼睛看左上；头没有歪。",
    prompt: (t) => editPrompt(t, `the pose of one arm and the gaze. ${cap(t.ownHand)} rises into the frame so that the index fingertip rests lightly beside the chin; the eyes look toward the upper left of the frame. The head stays level and the closed smile of Image 1 stays.`,
      `exactly one hand is visible: ${t.ownHand}, with the index fingertip beside the chin, drawn with five natural fingers and holding nothing; the other hand stays out of frame below the bottom edge.`, "arm") },
  { id: "expr_praise", zh: "点赞（有手）", batch: "P0", use: "答对的静态档、课后小结、完成提示",
    check: "只有一只手；握拳、拇指朝上；表情和原图一样。",
    prompt: (t) => editPrompt(t, `the pose of one arm. ${cap(t.ownHand)} rises into the frame at lower-chest height in a clear thumbs-up toward the viewer. The expression, the head and the gaze stay as in Image 1.`,
      `exactly one hand is visible: ${t.ownHand}, at lower-chest height, a closed fist with the thumb pointing up, holding nothing; the other hand stays out of frame below the bottom edge.`, "arm") },

  { id: "key_notes", zh: "关键帧 · 低头看笔记", batch: "P2", use: "进阶里\"保持低头备课\"三段式的中间姿势",
    check: "头微低、眼睛往画面下方看；闭嘴；没有手；背景不变。",
    prompt: (t) => editPrompt(t, "the head angle and the gaze. The head inclines slightly downward and the eyes look down past the bottom edge of the frame, in quiet concentration. The closed smile of Image 1 stays.", HANDS_NONE, "head") },
  { id: "key_board", zh: "关键帧 · 朝白板示意", batch: "P2", use: "进阶里\"保持看白板讲解\"三段式的中间姿势",
    check: "头和眼微转向画面右侧；画面右侧的一只手掌心朝右；五指正常。",
    prompt: (t) => editPrompt(t, "the head direction and the pose of one arm. The eyes and head turn a few degrees toward the right edge of the frame, and the hand at the viewer's right rises into the frame at lower-chest height, open, with the palm turned toward the right edge, fully inside the frame. The expression stays as in Image 1.",
      "exactly one hand is visible: the hand at the viewer's right, at lower-chest height, open, drawn with five natural fingers and holding nothing; the other hand stays out of frame below the bottom edge.", "headArm") },

  { id: "tod_morning", zh: "清晨的光", batch: "P2", use: "今天页早上的问候",
    check: "只有光变了：更清冷、更亮；人物和房间没变。",
    prompt: (t) => editPrompt(t, "the time of day and its light. Make it early morning: cooler, fresher light coming from the same side as in Image 1, slightly lower contrast, and a pale clear sky tone in the window. The character's own colors stay clearly recognisable.", HANDS_NONE, "relight") },
  { id: "tod_evening", zh: "傍晚的光", batch: "P2", use: "今天页傍晚的问候",
    check: "只有光变了：低角度的暖金色，窗里是落日的暖光；人物和房间没变。",
    prompt: (t) => editPrompt(t, "the time of day and its light. Make it early evening: warm, low golden light coming from the same side as in Image 1, a gentle amber tint in the room, and a warm low-sun glow in the window. The character's own colors stay clearly recognisable.", HANDS_NONE, "relight") },
  { id: "tod_night", zh: "夜晚的光", batch: "P2", use: "今天页夜里的问候",
    check: "窗外是深蓝色的夜；人物由同一侧的暖色灯光照亮；人物和房间没变。",
    prompt: (t) => editPrompt(t, "the time of day and its light. Make it night: the window shows a deep blue night, and the character is lit softly by a warm indoor lamp from the same side as the light in Image 1. The character's own colors stay clearly recognisable.", HANDS_NONE, "relight") },

  { id: "sheet_views", zh: "角色设定卡（三个角度）", batch: "P2", aspect: "3:2", use: "以后换工具、做宣传图、或给视频模型当参考时用；不直接进产品",
    check: "三个半身像大小一致；每个配饰的数量和所在的一侧都没变；没有文字。",
    prompt: (t) => [
      "Use case: character reference sheet for production use.",
      "Input images: Image 1 is the approved portrait of this original character. Use it as the identity reference; this is a new layout, not an edit of Image 1.",
      "Primary request: a model sheet that shows the exact same adult character from Image 1 three times in one row at the same scale, as a bust cropped at mid-chest so that the collar and chest details are visible: seen from the front, in three-quarter view turned toward the viewer's left, and in three-quarter view turned toward the viewer's right. The expression is the same calm closed smile in all three.",
      `Character: ${t.dna}`,
      `Sides: the words "viewer's left" and "viewer's right" in the description refer to the front view. Every accessory keeps the same count and stays on the same side of the character's own head and clothing in every view. ${t.ownSides}`,
      "Layout: wide 3:2 canvas, three equal cells in one row, evenly spaced, plain light neutral background, even flat lighting, no cell borders.",
      "Style: the same line art and shading style as Image 1.",
      "Avoid: text, letters, labels, watermark, logo, signature, borders, UI elements, any other character. This is an original character; do not imitate any existing franchise, studio or artist.",
    ].join("\n") },
];

// ───────────────────────────── 输出 ─────────────────────────────
const mdEscape = (s) => s.replace(/\|/g, "\\|");
const rev = (text) => createHash("sha1").update(text).digest("hex").slice(0, 6);
const videoJobs = [];
const imageJobs = [];

for (const t of TUTORS) {
  // 视频
  let md = `# ${t.num} ${t.name}（${t.role}）· 视频提示词\n\n`;
  md += `> 模型：MiniMax H3-Base，首尾帧模式（FL2VA）。首帧和尾帧都用 \`hub/${t.num}-${t.slug}-576x1024.png\`（跑不动时用 \`-480x864\` 那张，并把宽高改成 480×864）。\n`;
  md += `> 每段跑 3 个种子，按《00-先读我》第 6.4 节的"一分钟判片法"挑一条。提示词是英文的（这是官方要求），每段上面有中文说明。\n`;
  md += `> 单手动作从${t.handSide.endsWith("left") ? "画面左侧" : "画面右侧"}抬手（那一侧没有小配饰）；朝白板的动作固定用画面右侧的手。\n\n`;
  md += `## 这位老师"不能变"的地方（判片时逐条看）\n\n${t.checklist.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n`;
  md += `## 片段一览\n\n| 批次 | 片段 | 名称 | 类型 | 帧数 | 时长 |\n| --- | --- | --- | --- | --- | --- |\n`;
  for (const s of SLOTS) md += `| ${s.batch} | \`${s.id}\` | ${mdEscape(s.zh)} | ${s.kind === "loop" ? "循环" : "一次性"} | ${s.frames} | ${seconds(s.frames)} 秒 |\n`;
  md += "\n";
  for (const batch of ["P0", "P1", "P2"]) {
    md += `## ${batch === "P0" ? "第一批（P0）" : batch === "P1" ? "第二批（P1）" : "第三批（P2）"}\n\n`;
    for (const s of SLOTS.filter((x) => x.batch === batch)) {
      const prompt = videoPrompt(t, s);
      const idx = SLOTS.indexOf(s);
      const base = Number(t.num) * 1000 + (idx + 1) * 10;
      const hub = `hub/${t.num}-${t.slug}-${CANVAS.width}x${CANVAS.height}.png`;
      videoJobs.push({
        id: `${t.num}-${t.slug}__${s.id}`, tutor_id: t.id, slug: t.slug, slot: s.id, kind: s.kind, batch: s.batch,
        first_frame: hub, last_frame: hub,
        width: CANVAS.width, height: CANVAS.height, length: s.frames, seconds: seconds(s.frames), fps: FPS,
        keep_audio: Boolean(s.audio), seeds: [base + 1, base + 2, base + 3],
        prompt_rev: rev(`${prompt}|${s.frames}`), prompt,
      });
      md += `### \`${s.id}\` · ${s.zh}\n\n`;
      md += `- **什么时候播**：${s.when}\n- **判片要点**：${s.check}\n`;
      md += `- **参数**：${CANVAS.width}×${CANVAS.height}，${s.frames} 帧（${seconds(s.frames)} 秒），${s.kind === "loop" ? "循环片段" : "一次性动作"}${s.audio ? "，**保留声音**" : "，不出声音"}\n`;
      if (s.mouth === "speak") md += `- **台词**（${s.audio ? "会被听到" : "只为了让嘴动得自然，声音不进产品"}）：${lineOf(t, s)}\n`;
      md += `\n\`\`\`text\n${prompt}\n\`\`\`\n\n`;
    }
  }
  writeFileSync(join(VID_DIR, `${t.num}-${t.name}-视频提示词.md`), md, "utf8");

  // 图片
  let im = `# ${t.num} ${t.name}（${t.role}）· 图片提示词\n\n`;
  im += `> 模型：OpenAI Images 2.6（ChatGPT 或 Codex 里的生图）。上传 \`${t.num}-${t.slug}-anchor-1080x1920.png\` 作为第 1 张图，画幅选 9:16，粘贴提示词。\n`;
  im += `> 每一张都只改一个部位（表情，或一只手臂，或头的朝向，或光线）。每张图都从**原图**出发，不要在上一张改好的图上接着改（连改会越改越走样）。\n\n`;
  im += `## 这位老师"不能变"的地方（验收时逐条看）\n\n${t.checklist.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n`;
  for (const batch of ["P0", "P2"]) {
    im += `## ${batch === "P0" ? "第一批（P0）：表情与姿势" : "第三批（P2）：关键帧、不同时段的光、设定卡"}\n\n`;
    for (const j of IMAGE_JOBS.filter((x) => x.batch === batch)) {
      if (t.skipTod.includes(j.id)) {
        im += `### \`${j.id}\` · ${j.zh}\n\n这位老师的原图本来就是这个时段，这一张跳过，直接用原图。\n\n`;
        continue;
      }
      const prompt = j.prompt(t);
      const saveAs = `${t.num}-${t.slug}__${j.id}__v{n}.png`;
      imageJobs.push({
        id: `${t.num}-${t.slug}__${j.id}`, tutor_id: t.id, slug: t.slug, job: j.id, batch: j.batch,
        input_image: `${t.num}-${t.slug}-anchor-1080x1920.png`, aspect: j.aspect ?? "9:16",
        save_as: saveAs, prompt,
      });
      im += `### \`${j.id}\` · ${j.zh}\n\n- **用在哪**：${j.use}\n- **验收要点**：${j.check}\n- **画幅**：${j.aspect ?? "9:16"}\n- **保存为**：\`回传\\${t.num}-${t.slug}\\${saveAs.replace("{n}", "1")}\`（第二版用 v2）\n\n\`\`\`text\n${prompt}\n\`\`\`\n\n`;
    }
  }
  writeFileSync(join(IMG_DIR, `${t.num}-${t.name}-图片提示词.md`), im, "utf8");
}

writeFileSync(join(VID_DIR, "jobs.json"), JSON.stringify(videoJobs, null, 2) + "\n", "utf8");
writeFileSync(join(IMG_DIR, "image-jobs.json"), JSON.stringify(imageJobs, null, 2) + "\n", "utf8");

// ───────────────────────────── 自检 ─────────────────────────────
const problems = [];
for (const j of videoJobs) {
  if (!j.prompt.startsWith("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark")) problems.push(`${j.id}: 对齐句不对`);
  if (!j.prompt.includes(`aligns with the ${j.seconds}-second mark`)) problems.push(`${j.id}: 时长与帧数不一致`);
  if ((j.length - 5) % 17 !== 0) problems.push(`${j.id}: 帧数不是 17k+5`);
  if (j.length < 124 || j.length > 362) problems.push(`${j.id}: 帧数不在模型训练范围 124–362 内`);
  if (/\[\s*\d+(\.\d+)?\s*s/.test(j.prompt) || /\d\s*s\s*-\s*\d/.test(j.prompt)) problems.push(`${j.id}: 出现了时间区间`);
  for (const f of ["integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"]) if (!j.prompt.includes(f)) problems.push(`${j.id}: 缺字段 ${f}`);
  if (/\b(no|not|never|without|don't|avoid)\b/i.test(j.prompt.replace("non_diegetic_music", ""))) problems.push(`${j.id}: 含否定词（本地模型没有负向提示）`);
  if (/\b(whiteboard|desk|notes|paper|pen|book|outside the picture|below the frame)\b/i.test(j.prompt)) problems.push(`${j.id}: 点名了画面外的物件`);
  if (/[一-鿿]/.test(j.prompt.replace(/<d>\[Chinese\][^<]*<\/d>/g, ""))) problems.push(`${j.id}: 台词标签外出现中文`);
  if (j.width % 32 || j.height % 32) problems.push(`${j.id}: 宽高不是 32 的倍数`);
  if (/lips stay (gently )?closed/.test(j.prompt) && j.prompt.includes("<d>")) problems.push(`${j.id}: 同时写了闭嘴和台词`);
  if (/smile stays closed/.test(j.prompt) && j.prompt.includes("<d>")) problems.push(`${j.id}: 讲话片段里出现"笑不露齿"的要求`);
}
// 台词放得下吗：每秒约 4 个字，逗号或句号停 0.2 秒，开头 0.4 秒和结尾 1.0 秒要安静；自我介绍前面还有约 1.2 秒的点头。
for (const t of TUTORS) for (const s of SLOTS.filter((x) => x.mouth === "speak")) {
  const line = lineOf(t, s);
  const chars = (line.match(/[一-鿿]/g) ?? []).length;
  const pauses = (line.slice(0, -1).match(/[，。；]/g) ?? []).length;
  const need = chars / 4 + 0.2 * pauses + 1.4 + (s.lead ?? 0);
  if (need > Number(seconds(s.frames))) problems.push(`${t.slug}/${s.id}: 台词需要 ${need.toFixed(2)} 秒，片长只有 ${seconds(s.frames)} 秒`);
}
for (const j of imageJobs) {
  if (/(少年|少女|学生|schoolgirl|schoolboy|sailor|uniform|\bteen|\bgirl\b|\bboy\b|child|loli|shota)/i.test(j.prompt)) problems.push(`${j.id}: 含未成年指向的词`);
  if (!/adult/.test(j.prompt)) problems.push(`${j.id}: 没有写明成年`);
  if (!j.prompt.includes("Image 1")) problems.push(`${j.id}: 没有指明第 1 张图的角色`);
  if (/tod_/.test(j.job) && /Lighting \(as in Image 1\)/.test(j.prompt)) problems.push(`${j.id}: 换光线的任务里写了"光线照旧"`);
}
const words = (s) => s.split(/\s+/).length;
const lens = videoJobs.map((j) => words(j.prompt));
console.log(`视频任务 ${videoJobs.length} 条（${TUTORS.length} 位 × ${SLOTS.length} 段），提示词 ${Math.min(...lens)}–${Math.max(...lens)} 个英文词`);
console.log(`图片任务 ${imageJobs.length} 条`);
console.log(problems.length ? `自检发现 ${problems.length} 个问题：\n` + problems.join("\n") : "自检通过");
if (problems.length) process.exitCode = 1;
