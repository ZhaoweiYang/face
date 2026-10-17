// VoiceCard card page: listen to a card's voice messages; the owner can record new ones.

const HEADERS = { "X-Requested-With": "voicecard" };
const TOKEN = (location.pathname.match(/^\/c\/([A-Za-z0-9_-]{22})\/?$/) || [])[1] || null;
const view = document.getElementById("view");

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", json, form } = {}) {
  const headers = { ...HEADERS };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const res = await fetch(`/api${path}`, { method, headers, body, credentials: "same-origin" });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  if (!res.ok) {
    const detail = data && typeof data.detail === "string" ? data.detail : `请求失败（${res.status}）`;
    throw new ApiError(detail, res.status);
  }
  return data;
}

/** Tiny DOM builder; text is always set via textContent, never parsed as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer = 0;
function toast(text) {
  const node = document.getElementById("toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 3200);
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// --- views -----------------------------------------------------------------

function renderMessage(text, sub) {
  view.replaceChildren(
    el("section", { class: "hero" }, el("div", { class: "hero-icon" }, "🎙️"), el("h1", {}, text), sub && el("p", { class: "muted" }, sub)),
  );
}

async function load() {
  if (!TOKEN) {
    renderMessage("照片语音留言", "用手机触碰照片背后的卡片，就能听到留在照片里的声音。");
    return;
  }
  let card;
  try {
    card = await api(`/cards/${TOKEN}`);
  } catch (err) {
    if (err.status === 404) renderMessage("找不到这张卡片", "链接无效或卡片已停用。请重新触碰照片背后的卡片。");
    else if (err.status === 429) renderMessage("访问过于频繁", "请稍后再试。");
    else renderMessage("加载失败", err.message);
    return;
  }
  // The first signed-in visitor of an unclaimed card becomes its owner.
  if (!card.claimed && card.me) {
    try {
      await api(`/cards/${TOKEN}/claim`, { method: "POST" });
      toast("认领成功！现在只有你可以在这张卡片上留言");
    } catch (err) {
      toast(err.message);
    }
    card = await api(`/cards/${TOKEN}`);
  }
  render(card);
}

function render(card) {
  const title = card.title || "照片语音留言";
  const status = !card.claimed
    ? "这张卡片还没有主人"
    : card.is_owner
      ? "你是这张卡片的主人"
      : `${card.messages.length} 条留言`;

  const sections = [
    el("header", { class: "head" }, el("h1", {}, title), el("p", { class: "muted" }, status)),
    !card.claimed && claimPanel(),
    card.is_owner && ownerPanel(card),
    messageList(card),
    footer(card),
  ];
  view.replaceChildren(...sections.filter(Boolean));
}

function claimPanel() {
  return el(
    "section",
    { class: "card accent" },
    el("h2", {}, "认领这张卡片"),
    el("p", {}, "第一位登录并打开这张卡片的人会成为它的主人，只有主人可以录制和上传留言，其他人触碰卡片只能收听。"),
    authForm(load),
  );
}

function authForm(onDone, { compact = false } = {}) {
  let mode = "login";
  const username = el("input", { name: "username", autocomplete: "username", required: true, minlength: "2", maxlength: "32", placeholder: "用户名" });
  const password = el("input", { name: "password", type: "password", autocomplete: "current-password", required: true, minlength: "8", placeholder: "密码（至少 8 位）" });
  const submit = el("button", { class: "btn primary", type: "submit" }, "登录");
  const toggle = el("button", { class: "link", type: "button" }, "没有账号？注册");
  const error = el("p", { class: "error", hidden: true });

  toggle.addEventListener("click", () => {
    mode = mode === "login" ? "register" : "login";
    submit.textContent = mode === "login" ? "登录" : "注册并登录";
    toggle.textContent = mode === "login" ? "没有账号？注册" : "已有账号？登录";
    password.setAttribute("autocomplete", mode === "login" ? "current-password" : "new-password");
  });

  const form = el("form", { class: compact ? "auth compact" : "auth" }, username, password, error, submit, toggle);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      await api(`/auth/${mode}`, { method: "POST", json: { username: username.value, password: password.value } });
      await onDone();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function ownerPanel(card) {
  const titleInput = el("input", { value: card.title, maxlength: "60", placeholder: "给这张照片起个名字，例如：外婆的八十岁生日" });
  const save = el("button", { class: "btn", type: "button" }, "保存");
  save.addEventListener("click", async () => {
    try {
      await api(`/cards/${TOKEN}`, { method: "PATCH", json: { title: titleInput.value } });
      toast("已保存");
      load();
    } catch (err) {
      toast(err.message);
    }
  });

  const full = card.messages.length >= card.limits.max_messages;
  return el(
    "section",
    { class: "card accent" },
    el("h2", {}, "录一段留言"),
    full ? el("p", { class: "muted" }, `已达到 ${card.limits.max_messages} 条上限，删除旧留言后可以继续录制。`) : recorder(card.limits),
    el("div", { class: "row" }, titleInput, save),
  );
}

function pickMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  // AAC/mp4 first: it plays everywhere (iOS Safari records it; recent Chrome can too).
  // Otherwise Opus/webm, which the Python server can transcode with ffmpeg.
  return ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function extFor(type) {
  if (type.includes("mp4")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("webm")) return "webm";
  return "bin";
}

async function uploadBlob(blob, seconds, filename) {
  const form = new FormData();
  form.append("audio", blob, filename);
  form.append("duration", String(seconds));
  await api(`/cards/${TOKEN}/messages`, { method: "POST", form });
}

function recorder(limits) {
  const supported = window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
  const box = el("div", { class: "recorder" });

  if (!supported) {
    // Messages are recorded with the phone's microphone only; some in-app browsers
    // (and plain-http pages) don't expose it, so point people to the system browser.
    box.append(
      el(
        "p",
        { class: "muted" },
        window.isSecureContext
          ? "这个浏览器不能录音。请用手机自带的 Safari（iPhone）或 Chrome（安卓）打开这张卡片。"
          : "录音需要 HTTPS 安全连接，请通过卡片上的网址打开。",
      ),
    );
    return box;
  }

  let stream = null;
  let rec = null;
  let chunks = [];
  let blob = null;
  let started = 0;
  let seconds = 0;
  let ticker = 0;

  const time = el("div", { class: "rec-time" }, "0:00");
  const limit = el("div", { class: "muted small" }, `最长 ${fmtDuration(limits.max_seconds)}`);
  const recordBtn = el("button", { class: "rec-btn", type: "button", "aria-label": "开始录音" }, el("span", { class: "rec-dot" }));
  const preview = el("audio", { controls: true, hidden: true, preload: "auto" });
  const uploadBtn = el("button", { class: "btn primary", type: "button", hidden: true }, "上传这段留言");
  const retryBtn = el("button", { class: "btn", type: "button", hidden: true }, "重录");

  function setState(state) {
    box.dataset.state = state;
    const recorded = state === "recorded";
    preview.hidden = !recorded;
    uploadBtn.hidden = !recorded;
    retryBtn.hidden = !recorded;
    recordBtn.hidden = recorded;
    recordBtn.setAttribute("aria-label", state === "recording" ? "停止录音" : "开始录音");
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast("无法使用麦克风，请在浏览器设置里允许麦克风权限");
      return;
    }
    const mimeType = pickMimeType();
    rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
      preview.src = URL.createObjectURL(blob);
      setState("recorded");
    };
    rec.start(1000);
    started = performance.now();
    seconds = 0;
    setState("recording");
    ticker = setInterval(() => {
      seconds = (performance.now() - started) / 1000;
      time.textContent = fmtDuration(seconds);
      if (seconds >= limits.max_seconds) stop();
    }, 250);
  }

  function stop() {
    clearInterval(ticker);
    seconds = (performance.now() - started) / 1000;
    time.textContent = fmtDuration(seconds);
    if (rec && rec.state !== "inactive") rec.stop();
  }

  recordBtn.addEventListener("click", () => (box.dataset.state === "recording" ? stop() : start()));
  retryBtn.addEventListener("click", () => {
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.removeAttribute("src");
    blob = null;
    time.textContent = "0:00";
    setState("idle");
  });
  uploadBtn.addEventListener("click", async () => {
    if (!blob) return;
    if (blob.size > limits.max_bytes) {
      toast("录音太大了，请录短一点");
      return;
    }
    uploadBtn.disabled = true;
    uploadBtn.textContent = "上传中…";
    try {
      await uploadBlob(blob, seconds.toFixed(1), `voice.${extFor(blob.type)}`);
      toast("留言已上传");
      load();
    } catch (err) {
      toast(err.message);
      uploadBtn.disabled = false;
      uploadBtn.textContent = "上传这段留言";
    }
  });

  box.append(el("div", { class: "rec-row" }, recordBtn, el("div", {}, time, limit)), preview, el("div", { class: "row" }, retryBtn, uploadBtn));
  setState("idle");
  return box;
}

function messageList(card) {
  if (!card.messages.length) {
    return el(
      "section",
      { class: "card empty" },
      el("p", { class: "muted" }, card.is_owner ? "还没有留言，录下第一段声音吧。" : "这张照片还没有留言。"),
    );
  }

  const players = [];
  let playingAll = false;
  const items = card.messages.map((m, i) => {
    const audio = el("audio", { controls: true, preload: "none", src: m.url });
    players.push(audio);
    const del =
      card.is_owner &&
      el(
        "button",
        {
          class: "link danger",
          type: "button",
          onclick: async () => {
            if (!confirm("确定删除这条留言吗？删除后无法恢复。")) return;
            try {
              await api(`/cards/${TOKEN}/messages/${m.id}`, { method: "DELETE" });
              toast("已删除");
              load();
            } catch (err) {
              toast(err.message);
            }
          },
        },
        "删除",
      );
    return el(
      "li",
      { class: "msg" },
      el("div", { class: "msg-meta" }, el("span", {}, `第 ${i + 1} 条 · ${fmtDate(m.created_at)}`), m.duration ? el("span", {}, fmtDuration(m.duration)) : null, del),
      audio,
    );
  });

  // Playing one pauses the others; "play all" chains them in order.
  players.forEach((p, i) => {
    p.addEventListener("play", () => players.forEach((q) => q !== p && q.pause()));
    p.addEventListener("ended", () => {
      if (playingAll && players[i + 1]) players[i + 1].play();
      else playingAll = false;
    });
  });
  const playAll = el("button", { class: "btn primary big", type: "button" }, `▶ 依次播放全部（${players.length}）`);
  playAll.addEventListener("click", () => {
    playingAll = true;
    players[0].currentTime = 0;
    players[0].play();
  });

  return el("section", { class: "card" }, players.length > 1 && playAll, el("ol", { class: "msgs" }, items));
}

function footer(card) {
  if (card.me) {
    const out = el("button", { class: "link", type: "button" }, "退出登录");
    out.addEventListener("click", async () => {
      await api("/auth/logout", { method: "POST" });
      load();
    });
    return el("footer", { class: "foot muted small" }, `已登录：${card.me} · `, out);
  }
  if (!card.claimed) return null;
  // The owner on a new phone needs a way to sign in.
  const box = el("div", { hidden: true }, authForm(load, { compact: true }));
  const open = el("button", { class: "link", type: "button" }, "我是卡片主人，登录后留言");
  open.addEventListener("click", () => {
    box.hidden = !box.hidden;
  });
  return el("footer", { class: "foot muted small" }, open, box);
}

load();
