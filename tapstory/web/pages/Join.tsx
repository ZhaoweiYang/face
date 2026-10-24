// Accepting an invite link from a family admin.

import { useEffect, useState } from "preact/hooks";
import { api, type Me } from "../api";
import { loginUrl, navigate } from "../router";
import { refreshMe, toast } from "../store";
import { Spinner } from "../ui";

export function JoinPage({ token }: { token: string }) {
  const [view, setView] = useState<{ family: { id: number; name: string }; member: boolean; me: Me | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<typeof view>(`/invites/${token}`).then(setView, (err) => setError(err.message));
  }, [token]);

  if (error) {
    return (
      <main class="page center-page">
        <div class="empty">
          <h1>邀请不可用</h1>
          <p class="muted">{error}</p>
        </div>
      </main>
    );
  }
  if (!view) return <Spinner />;

  async function join(e: Event) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ family_id: number }>(`/invites/${token}/accept`, { method: "POST", json: { nickname } });
      await refreshMe();
      toast(`已加入「${view!.family.name}」`);
      navigate(`/app?f=${res.family_id}`, { replace: true });
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main class="page center-page">
      <div class="panel join">
        <p class="eyebrow">家庭邀请</p>
        <h1>加入「{view.family.name}」</h1>
        {view.member ? (
          <>
            <p class="muted">你已经是这个家庭的成员了。</p>
            <a class="btn btn-primary btn-block" href={`/app?f=${view.family.id}`}>
              进入家庭
            </a>
          </>
        ) : !view.me ? (
          <>
            <p class="muted">登录后即可加入，和家人一起在照片里留下声音。</p>
            <a class="btn btn-primary btn-block btn-big" href={loginUrl()}>
              登录并加入
            </a>
          </>
        ) : (
          <form class="form" onSubmit={join}>
            <label class="field">
              <span>你在家里的称呼</span>
              <input id="join-nickname" value={nickname} onInput={(e) => setNickname(e.currentTarget.value)} maxLength={30} placeholder="例如：孙女 小美" />
            </label>
            <button type="submit" class="btn btn-primary btn-block btn-big" disabled={busy}>
              {busy ? "加入中…" : "加入家庭"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
