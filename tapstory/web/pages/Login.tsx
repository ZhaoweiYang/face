// TapStory login: Google, Apple, or a one-time code sent to an email address.

import { useState } from "preact/hooks";
import { api } from "../api";
import { navigate } from "../router";
import { refreshMe, useStore } from "../store";
import { Spinner } from "../ui";

export function LoginPage({ next }: { next: string }) {
  const { config } = useStore();
  const [step, setStep] = useState<"choose" | "email" | "code">("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!config) return <Spinner />;
  const p = config.providers;
  const nextParam = encodeURIComponent(next);

  async function sendCode(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ dev_code?: string }>("/auth/email/start", { method: "POST", json: { email } });
      setDevCode(res.dev_code ?? null);
      setStep("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/email/verify", { method: "POST", json: { email, code } });
      await refreshMe();
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main class="page login">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true" />
        <h1>TapStory</h1>
        <p class="muted">碰一碰，听见家人的声音</p>
      </div>

      {step === "choose" && (
        <div class="stack">
          {p.google && (
            <a class="btn btn-block btn-big btn-outline" href={`/api/auth/google/start?next=${nextParam}`}>
              <span class="provider provider-google" aria-hidden="true">G</span> Google 登录
            </a>
          )}
          {p.apple && (
            <a class="btn btn-block btn-big btn-dark" href={`/api/auth/apple/start?next=${nextParam}`}>
              <svg class="provider-apple" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.8-3-.8C6.9 7.4 5.5 8.3 4.7 9.7c-1.6 2.8-.4 6.9 1.1 9.2.8 1.1 1.7 2.3 2.9 2.3 1.2-.1 1.6-.8 3-.8s1.8.8 3 .8c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.4-3.7ZM14.2 5.8c.6-.8 1.1-1.8 1-2.8-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.7-1 2.7 1 .1 2.1-.5 2.7-1.3Z" />
              </svg>
              Apple 登录
            </a>
          )}
          {p.email && (
            <button type="button" class="btn btn-block btn-big btn-outline" onClick={() => setStep("email")}>
              <span class="provider" aria-hidden="true">@</span> 邮箱登录
            </button>
          )}
          {!p.google && !p.apple && !p.email && <p class="notice">还没有配置登录方式，请联系管理员。</p>}
        </div>
      )}

      {step === "email" && (
        <form class="form" onSubmit={sendCode}>
          <label class="field">
            <span>邮箱</span>
            <input id="login-email" type="email" inputMode="email" autoComplete="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} placeholder="name@example.com" required />
          </label>
          {error && <p class="error">{error}</p>}
          <button type="submit" class="btn btn-primary btn-block btn-big" disabled={busy}>
            {busy ? "发送中…" : "发送验证码"}
          </button>
          <button type="button" class="btn btn-ghost btn-block" onClick={() => setStep("choose")}>
            其他登录方式
          </button>
        </form>
      )}

      {step === "code" && (
        <form class="form" onSubmit={verify}>
          <p class="lead">验证码已发送到 {email}，10 分钟内有效。</p>
          {devCode && (
            <p class="notice">
              测试模式：验证码是 <strong>{devCode}</strong>（正式上线前请关闭测试模式）
            </p>
          )}
          <label class="field">
            <span>验证码</span>
            <input id="login-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))} placeholder="6 位数字" required />
          </label>
          {error && <p class="error">{error}</p>}
          <button type="submit" class="btn btn-primary btn-block btn-big" disabled={busy || code.length !== 6}>
            {busy ? "登录中…" : "登录"}
          </button>
          <button type="button" class="btn btn-ghost btn-block" onClick={() => setStep("email")}>
            重新获取验证码
          </button>
        </form>
      )}
    </main>
  );
}
