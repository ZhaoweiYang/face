// The message list from the design: avatar, name, time, and a voice bubble that plays on tap.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Message } from "../api";
import { Avatar, Icon, fmtDate, fmtDuration } from "../ui";

export function Messages({ messages, onDelete }: { messages: Message[]; onDelete?: (m: Message) => void }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const queue = useRef<string[]>([]);
  // Read through a ref: the audio "ended" handler is created once.
  const list = useRef(messages);
  list.current = messages;

  useEffect(() => {
    const a = new Audio();
    a.preload = "none";
    a.ontimeupdate = () => setProgress(a.duration ? a.currentTime / a.duration : 0);
    a.onended = () => {
      const next = queue.current.shift();
      if (next) start(next, false);
      else {
        setPlaying(null);
        setProgress(0);
      }
    };
    a.onerror = () => setPlaying(null);
    audio.current = a;
    return () => {
      a.pause();
      a.src = "";
    };
  }, []);

  function start(id: string, resetQueue = true) {
    const a = audio.current!;
    const m = list.current.find((x) => x.id === id);
    if (!m) return;
    if (resetQueue) queue.current = [];
    a.src = m.url;
    setPlaying(id);
    setProgress(0);
    a.play().catch(() => setPlaying(null));
  }

  function toggle(id: string) {
    const a = audio.current!;
    if (playing === id) {
      if (a.paused) a.play();
      else {
        a.pause();
        setPlaying(null);
      }
      return;
    }
    start(id);
  }

  function playAll() {
    const ids = messages.map((m) => m.id);
    start(ids[0]);
    queue.current = ids.slice(1);
  }

  if (!messages.length) return null;
  const longest = Math.max(...messages.map((m) => m.duration || 1), 30);

  return (
    <section class="messages" aria-label="留言">
      {messages.length > 1 && (
        <button class="link play-all" type="button" onClick={playAll}>
          <Icon name="play" /> 依次播放全部
        </button>
      )}
      <ol>
        {messages.map((m) => {
          const active = playing === m.id;
          const width = 46 + 54 * Math.min(1, (m.duration || 1) / longest);
          return (
            <li class="msg" key={m.id}>
              <Avatar name={m.author.name} src={m.author.avatar} />
              <div class="msg-body">
                <div class="msg-head">
                  <span class="msg-name">{m.author.name}</span>
                  <time class="msg-time">{fmtDate(m.created_at)}</time>
                </div>
                <div class="msg-row">
                  <button
                    type="button"
                    class={`bubble ${active ? "is-playing" : ""}`}
                    style={{ width: `${width}%`, "--p": active ? progress : 0 }}
                    onClick={() => toggle(m.id)}
                    aria-label={`${active ? "暂停" : "播放"} ${m.author.name} 的留言，${fmtDuration(m.duration)}`}
                  >
                    <span class="bubble-fill" aria-hidden="true" />
                    <Icon name={active ? "pause" : "play"} />
                    <span class="bubble-len">{fmtDuration(m.duration)}</span>
                    <span class="bubble-wave" aria-hidden="true">
                      <Icon name="wave" />
                    </span>
                  </button>
                  {m.can_delete && onDelete && (
                    <button type="button" class="icon-btn" aria-label="删除这条留言" onClick={() => onDelete(m)}>
                      <Icon name="more" />
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
