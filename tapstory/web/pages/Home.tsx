// The signed-in app: 卡片 / 家庭成员 / 我的 tabs for one family at a time.

import { useEffect, useState } from "preact/hooks";
import { api, type FamilyView } from "../api";
import { UpgradePanel } from "../components/Plans";
import { loginUrl, navigate } from "../router";
import { refreshMe, toast, useStore } from "../store";
import { Avatar, Icon, PlanBadge, Sheet, Spinner, fmtDay } from "../ui";

type Tab = "cards" | "family" | "me";

export function HomePage({ url }: { url: URL }) {
  const { ready, me, families } = useStore();
  const tab = (url.searchParams.get("tab") as Tab) || "cards";
  const familyId = Number(url.searchParams.get("f")) || families[0]?.id || null;
  const [view, setView] = useState<FamilyView | null>(null);

  async function load() {
    if (!familyId) return;
    try {
      // The family list (plans, roles) can change from other phones; refresh it too.
      const [v] = await Promise.all([api<FamilyView>(`/families/${familyId}`), refreshMe()]);
      setView(v);
    } catch (err) {
      toast((err as Error).message);
    }
  }

  useEffect(() => {
    if (ready && !me) navigate(loginUrl(), { replace: true });
  }, [ready, me]);
  useEffect(() => {
    setView(null);
    load();
  }, [familyId]);

  if (!ready || !me) return <Spinner />;
  if (!familyId) return <NoFamily />;

  const go = (t: Tab) => navigate(`/app?tab=${t}&f=${familyId}`, { replace: true });

  return (
    <div class="app">
      <header class="app-head">
        <h1>{view?.family.name ?? "…"}</h1>
        {view && <PlanBadge plan={view.family.plan} />}
      </header>
      <main class="page app-page">
        {!view ? (
          <Spinner />
        ) : tab === "cards" ? (
          <CardsTab view={view} />
        ) : tab === "family" ? (
          <FamilyTab view={view} reload={load} />
        ) : (
          <MeTab view={view} reload={load} />
        )}
      </main>
      <nav class="tabbar" aria-label="主导航">
        {(
          [
            ["cards", "卡片"],
            ["family", "家庭成员"],
            ["me", "我的"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button type="button" key={t} class={tab === t ? "is-on" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => go(t)}>
            {label}
            {t === "family" && view && view.applications.length > 0 && <span class="dot" aria-label={`${view.applications.length} 个待处理申请`} />}
          </button>
        ))}
      </nav>
    </div>
  );
}

function NoFamily() {
  const [name, setName] = useState("");
  async function create(e: Event) {
    e.preventDefault();
    try {
      const res = await api<{ id: number }>("/families", { method: "POST", json: { name } });
      await refreshMe();
      navigate(`/app?f=${res.id}`, { replace: true });
    } catch (err) {
      toast((err as Error).message);
    }
  }
  return (
    <main class="page center-page">
      <form class="panel form" onSubmit={create}>
        <h1>创建你的家庭</h1>
        <p class="muted">家庭里的卡片和留言只有家人能管理。也可以直接用手机碰一张新的 TapStory 卡片，按提示激活。</p>
        <label class="field">
          <span>家庭名称</span>
          <input id="new-family" value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={30} placeholder="例如：杨家" required />
        </label>
        <button type="submit" class="btn btn-primary btn-block btn-big" disabled={!name.trim()}>
          创建
        </button>
      </form>
    </main>
  );
}

function CardsTab({ view }: { view: FamilyView }) {
  if (!view.cards.length) {
    return (
      <div class="empty">
        <div class="empty-mark" aria-hidden="true">
          <Icon name="wave" />
        </div>
        <h2>还没有卡片</h2>
        <p class="muted">用手机碰一下新的 TapStory 卡片，就能把它激活到这个家庭。</p>
      </div>
    );
  }
  return (
    <ul class="list">
      {view.cards.map((c) => (
        <li key={c.id}>
          <a class="list-item" href={`/app/cards/${c.id}`}>
            <span class="list-icon" aria-hidden="true">
              <Icon name="wave" />
            </span>
            <span class="list-main">
              <strong>{c.name || "未命名的卡片"}</strong>
              <span class="muted small">{c.messages ? `${c.messages} 条留言 · 最近 ${fmtDay(c.last_at!)}` : "还没有留言"}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function FamilyTab({ view, reload }: { view: FamilyView; reload: () => void }) {
  const admin = view.role === "admin";
  const family = view.family;
  const [sheet, setSheet] = useState<null | "upgrade" | { invite: string }>(null);

  async function invite() {
    if (family.plan !== "family") return setSheet("upgrade");
    try {
      const res = await api<{ url: string }>(`/families/${family.id}/invites`, { method: "POST" });
      setSheet({ invite: res.url });
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function decide(id: number, approve: boolean) {
    try {
      await api(`/families/${family.id}/applications/${id}/${approve ? "approve" : "reject"}`, { method: "POST" });
      toast(approve ? "已同意，对方现在可以留言了" : "已拒绝");
      reload();
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function remove(id: number, name: string) {
    try {
      await api(`/families/${family.id}/members/${id}`, { method: "DELETE" });
      toast(`已移除 ${name}`);
      reload();
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function share(url: string) {
    try {
      if (navigator.share) await navigator.share({ title: `加入「${family.name}」`, text: `邀请你加入「${family.name}」，一起在 TapStory 照片里留言`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast("邀请链接已复制");
      }
    } catch {
      // user cancelled the share sheet
    }
  }

  return (
    <div class="stack">
      {admin && (
        <button type="button" class="btn btn-primary btn-block" onClick={invite}>
          <Icon name="plus" /> 邀请成员
        </button>
      )}

      {admin && view.applications.length > 0 && (
        <section class="panel">
          <h2 class="section-title">加入申请</h2>
          <ul class="list plain">
            {view.applications.map((a) => (
              <li class="apply-item" key={a.id}>
                <div class="list-item static">
                  <Avatar name={a.identity || a.name} src={a.avatar_url} />
                  <span class="list-main">
                    <strong>{a.identity}</strong>
                    <span class="muted small">
                      {a.name}
                      {a.email ? ` · ${a.email}` : ""}
                    </span>
                    {a.reason && <span class="quote">“{a.reason}”</span>}
                    {a.card_name && <span class="muted small">来自卡片：{a.card_name}</span>}
                  </span>
                </div>
                <div class="row">
                  <button type="button" class="btn" onClick={() => decide(a.id, false)}>
                    拒绝
                  </button>
                  <button type="button" class="btn btn-primary" onClick={() => decide(a.id, true)}>
                    同意
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="panel">
        <h2 class="section-title">家庭成员 · {view.members.length}</h2>
        <ul class="list plain">
          {view.members.map((m) => (
            <li class="list-item static" key={m.id}>
              <Avatar name={m.name} src={m.avatar} />
              <span class="list-main">
                <strong>
                  {m.name}
                  {m.me && <span class="muted"> （我）</span>}
                </strong>
                <span class="muted small">{m.email ?? m.account}</span>
              </span>
              {m.role === "admin" ? (
                <span class="badge">管理员</span>
              ) : (
                admin && (
                  <button type="button" class="link danger small" onClick={() => remove(m.id, m.name)}>
                    移除
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
        {family.plan !== "family" && <p class="muted small">标准版仅支持 1 人留言。升级家庭版后，家人都能在卡片上留言。</p>}
      </section>

      <Sheet open={sheet === "upgrade"} onClose={() => setSheet(null)} title="升级为家庭版">
        <UpgradePanel
          familyId={family.id}
          familyName={family.name}
          mode="owner"
          onLater={() => setSheet(null)}
          onUpgraded={async () => {
            toast("已升级为家庭版");
            await refreshMe();
            reload();
            setSheet(null);
          }}
        />
      </Sheet>
      <Sheet open={typeof sheet === "object" && sheet !== null} onClose={() => setSheet(null)} title="邀请家人">
        {typeof sheet === "object" && sheet && (
          <div class="stack">
            <p class="lead">把链接发给家人，对方登录后即可加入「{family.name}」。链接 7 天内有效。</p>
            <input class="copy-field" readOnly value={sheet.invite} onFocus={(e) => e.currentTarget.select()} aria-label="邀请链接" />
            <button type="button" class="btn btn-primary btn-block" onClick={() => share(sheet.invite)}>
              <Icon name="share" /> 发送邀请
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function MeTab({ view, reload }: { view: FamilyView; reload: () => void }) {
  const { me, families } = useStore();
  const [name, setName] = useState(me!.name);
  const [sheet, setSheet] = useState<null | "upgrade" | "new">(null);
  const [newName, setNewName] = useState("");
  const family = view.family;

  async function saveName(e: Event) {
    e.preventDefault();
    try {
      await api("/me", { method: "PATCH", json: { name } });
      await refreshMe();
      toast("已保存");
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function createFamily(e: Event) {
    e.preventDefault();
    try {
      const res = await api<{ id: number }>("/families", { method: "POST", json: { name: newName } });
      await refreshMe();
      setSheet(null);
      navigate(`/app?tab=me&f=${res.id}`, { replace: true });
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    await refreshMe();
    navigate("/", { replace: true });
  }

  return (
    <div class="stack">
      <form class="panel profile" onSubmit={saveName}>
        <Avatar name={me!.name} src={me!.avatar} size={56} />
        <div class="grow">
          <label class="field">
            <span>名字</span>
            <input id="me-name" value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={40} />
          </label>
          {me!.email && <p class="muted small">{me!.email}</p>}
        </div>
        <button type="submit" class="btn" disabled={!name.trim() || name === me!.name}>
          保存
        </button>
      </form>

      <section class="panel">
        <h2 class="section-title">当前家庭套餐</h2>
        <p>
          {family.name} <PlanBadge plan={family.plan} />
        </p>
        <p class="muted small">{family.plan === "family" ? `有效期至 ${fmtDay(family.plan_until)}` : "标准版：仅 1 人可留言，音频永久保存"}</p>
        <button type="button" class="btn btn-block" onClick={() => setSheet("upgrade")}>
          {family.plan === "family" ? "续费家庭版" : "升级家庭版"}
        </button>
      </section>

      <section class="panel">
        <h2 class="section-title">我的家庭</h2>
        <ul class="list plain">
          {families.map((f) => (
            <li key={f.id}>
              <a class={`list-item ${f.id === family.id ? "is-current" : ""}`} href={`/app?tab=me&f=${f.id}`}>
                <span class="list-main">
                  <strong>{f.name}</strong>
                  <span class="muted small">{f.role === "admin" ? "管理员" : "成员"}</span>
                </span>
                <PlanBadge plan={f.plan} />
              </a>
            </li>
          ))}
        </ul>
        <button type="button" class="link" onClick={() => setSheet("new")}>
          + 新建家庭
        </button>
      </section>

      <button type="button" class="btn btn-ghost btn-block danger" onClick={logout}>
        退出登录
      </button>

      <Sheet open={sheet === "upgrade"} onClose={() => setSheet(null)} title={family.plan === "family" ? "续费家庭版" : "升级为家庭版"}>
        <UpgradePanel
          familyId={family.id}
          familyName={family.name}
          mode="owner"
          onLater={() => setSheet(null)}
          onUpgraded={async () => {
            toast("家庭版已开通");
            await refreshMe();
            reload();
            setSheet(null);
          }}
        />
      </Sheet>
      <Sheet open={sheet === "new"} onClose={() => setSheet(null)} title="新建家庭">
        <form class="form" onSubmit={createFamily}>
          <label class="field">
            <span>家庭名称</span>
            <input id="me-new-family" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} maxLength={30} placeholder="例如：外婆家" required />
          </label>
          <button type="submit" class="btn btn-primary btn-block" disabled={!newName.trim()}>
            创建
          </button>
        </form>
      </Sheet>
    </div>
  );
}
