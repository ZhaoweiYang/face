// What a phone opens after tapping a card (the whole left/top of the flow chart).

import { useEffect, useState } from "preact/hooks";
import { ApiError, api, type CardView, type FamilySummary, type Message } from "../api";
import { Messages } from "../components/Messages";
import { ApplyPanel, UpgradePanel } from "../components/Plans";
import { Recorder } from "../components/Recorder";
import { loginUrl, navigate } from "../router";
import { refreshMe, toast } from "../store";
import { Icon, PlanBadge, Sheet, Spinner } from "../ui";

type Panel = null | "record" | "apply" | "upgrade" | "upsell" | "expired" | { delete: Message };

export function CardPage({ kind, cardRef }: { kind: "t" | "i"; cardRef: string }) {
  const path = `/cards/${kind}/${cardRef}`;
  const [view, setView] = useState<CardView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [panel, setPanel] = useState<Panel>(null);

  async function load() {
    try {
      const v = await api<CardView>(path);
      // Not activated and not signed in: the flow goes straight to login.
      if (!v.card.activated && !v.me) return navigate(loginUrl(), { replace: true });
      setView(v);
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    }
  }

  useEffect(() => {
    setView(null);
    load();
  }, [path]);

  if (error) {
    return (
      <main class="page center-page">
        <div class="empty">
          <div class="empty-mark" aria-hidden="true">
            <Icon name="wave" />
          </div>
          <h1>{error.status === 404 ? "找不到这张卡片" : error.status === 429 ? "访问太频繁了" : "加载失败"}</h1>
          <p class="muted">{error.status === 404 ? "链接无效或卡片已停用，请重新碰一下照片背后的卡片。" : error.status === 429 ? "请稍等一分钟再试。" : error.message}</p>
        </div>
      </main>
    );
  }
  if (!view) return <Spinner />;

  // Not activated: sign in first, then bind it to a family (流程图左侧).
  if (!view.card.activated) {
    return <Activate token={cardRef} families={view.families ?? []} onDone={load} />;
  }

  const family = view.card.family!;
  const isMember = Boolean(view.role);

  function tapRecord() {
    switch (view!.record_block) {
      case null:
      case undefined:
        return setPanel("record");
      case "login":
        return navigate(loginUrl());
      case "apply":
        return setPanel("apply");
      case "upgrade":
        return setPanel("upgrade");
      case "plan_expired":
        return setPanel("expired");
      case "pending":
        return toast("申请已发送，等待家庭管理员同意");
    }
  }

  async function send(blob: Blob, filename: string, seconds: number) {
    const form = new FormData();
    form.append("audio", blob, filename);
    form.append("duration", String(seconds));
    const res = await api<{ upsell: boolean }>(`${path}/messages`, { method: "POST", form });
    toast("留言已发送");
    setPanel(res.upsell ? "upsell" : null);
    await load();
  }

  async function remove(m: Message) {
    try {
      await api(`${path}/messages/${m.id}`, { method: "DELETE" });
      toast("已删除");
      setPanel(null);
      await load();
    } catch (err) {
      toast((err as Error).message);
    }
  }

  return (
    <main class="page card-page">
      <header class="card-head">
        <div>
          <p class="eyebrow">
            {family.name} <PlanBadge plan={family.plan} />
          </p>
          <h1>{view.card.name || "TapStory"}</h1>
        </div>
        {isMember && (
          <a class="chip" href={`/app?f=${family.id}`}>
            我的家庭
          </a>
        )}
      </header>

      {isMember && !view.card.name && <NameCard path={path} familyName={family.name} onSaved={load} />}

      {view.messages!.length ? (
        <Messages messages={view.messages!} onDelete={(m) => setPanel({ delete: m })} />
      ) : (
        <div class="empty slim">
          <p class="muted">{isMember ? "还没有留言，录下第一段声音吧。" : "这里还没有留言。"}</p>
        </div>
      )}

      <div class="dock">
        <button type="button" class="btn btn-primary btn-block btn-big" onClick={tapRecord} disabled={view.record_block === "pending"}>
          <Icon name="mic" /> {view.record_block === "pending" ? "已申请，等待管理员同意" : "留言录音"}
        </button>
      </div>

      <Sheet open={panel === "record"} onClose={() => setPanel(null)} title="录一段留言">
        <Recorder maxSeconds={view.limits.max_seconds} maxBytes={view.limits.max_bytes} onSend={send} />
      </Sheet>
      <Sheet open={panel === "apply"} onClose={() => setPanel(null)} title="申请加入家庭">
        <ApplyPanel
          cardPath={path}
          familyName={family.name}
          onSent={() => {
            setPanel(null);
            toast("申请已发送，等待家庭管理员同意");
            load();
          }}
        />
      </Sheet>
      <Sheet open={panel === "upgrade"} onClose={() => setPanel(null)} title="升级为家庭版">
        <UpgradePanel
          familyId={family.id}
          familyName={family.name}
          mode="visitor"
          onUpgraded={async () => {
            toast("已升级为家庭版");
            await load();
            setPanel("apply");
          }}
        />
      </Sheet>
      <Sheet open={panel === "upsell"} onClose={() => setPanel(null)} title="升级为家庭版">
        <UpgradePanel
          familyId={family.id}
          familyName={family.name}
          mode="owner"
          onLater={() => setPanel(null)}
          onUpgraded={async () => {
            toast("已升级为家庭版");
            await refreshMe();
            navigate(`/app?tab=family&f=${family.id}`);
          }}
        />
      </Sheet>
      <Sheet open={panel === "expired"} onClose={() => setPanel(null)} title="家庭版已到期">
        <p class="lead">标准版仅支持 1 人留言（家庭管理员）。请联系家庭管理员续费家庭版后再留言。</p>
        <button type="button" class="btn btn-block" onClick={() => setPanel(null)}>
          知道了
        </button>
      </Sheet>
      <Sheet open={typeof panel === "object" && panel !== null} onClose={() => setPanel(null)} title="删除留言">
        <p class="lead">删除后无法恢复。</p>
        <div class="row">
          <button type="button" class="btn" onClick={() => setPanel(null)}>
            取消
          </button>
          <button type="button" class="btn btn-danger" onClick={() => typeof panel === "object" && panel && remove(panel.delete)}>
            删除
          </button>
        </div>
      </Sheet>
    </main>
  );
}

function NameCard({ path, familyName, onSaved }: { path: string; familyName: string; onSaved: () => void }) {
  const [name, setName] = useState("");
  async function save(e: Event) {
    e.preventDefault();
    try {
      await api(path, { method: "PATCH", json: { name } });
      onSaved();
    } catch (err) {
      toast((err as Error).message);
    }
  }
  return (
    <form class="panel name-card" onSubmit={save}>
      <label class="field">
        <span>给卡片起个名字</span>
        <input id="card-name" value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={40} placeholder="这个 TapStory 贴在了哪个物品上？" />
      </label>
      <p class="muted small">所属家庭：{familyName}</p>
      <button type="submit" class="btn btn-block" disabled={!name.trim()}>
        保存
      </button>
    </form>
  );
}

/** 激活：create a family if the user has none, then pick the family for this card. */
function Activate({ token, families, onDone }: { token: string; families: FamilySummary[]; onDone: () => void }) {
  const [creating, setCreating] = useState(families.length === 0);
  const [familyName, setFamilyName] = useState("");
  const [choice, setChoice] = useState<number | null>(families[0]?.id ?? null);
  const [cardName, setCardName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = creating ? { family_name: familyName, card_name: cardName } : { family_id: choice, card_name: cardName };
      await api(`/cards/t/${token}/activate`, { method: "POST", json: body });
      await refreshMe();
      toast("卡片已激活");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="page">
      <header class="card-head">
        <div>
          <p class="eyebrow">新的 TapStory</p>
          <h1>激活这张卡片</h1>
        </div>
      </header>
      <form class="form panel" onSubmit={activate}>
        {creating ? (
          <label class="field">
            <span>{families.length ? "新家庭名称" : "先创建你的家庭"}</span>
            <input id="family-name" value={familyName} onInput={(e) => setFamilyName(e.currentTarget.value)} maxLength={30} placeholder="例如：杨家" required />
          </label>
        ) : (
          <fieldset class="field">
            <legend>卡片归属的家庭</legend>
            <div class="choices">
              {families.map((f) => (
                <label class={`choice ${choice === f.id ? "is-on" : ""}`} key={f.id}>
                  <input type="radio" name="family" checked={choice === f.id} onChange={() => setChoice(f.id)} />
                  <span>{f.name}</span>
                  <PlanBadge plan={f.plan} />
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {families.length > 0 && (
          <button type="button" class="link" onClick={() => setCreating(!creating)}>
            {creating ? "选择已有家庭" : "+ 新建家庭"}
          </button>
        )}
        <label class="field">
          <span>给卡片起个名字（可选）</span>
          <input id="activate-card-name" value={cardName} onInput={(e) => setCardName(e.currentTarget.value)} maxLength={40} placeholder="这个 TapStory 贴在了哪个物品上？" />
        </label>
        {error && <p class="error">{error}</p>}
        <button type="submit" class="btn btn-primary btn-block btn-big" disabled={busy || (creating ? !familyName.trim() : !choice)}>
          {busy ? "激活中…" : creating && !families.length ? "创建家庭并激活" : "激活"}
        </button>
      </form>
    </main>
  );
}
