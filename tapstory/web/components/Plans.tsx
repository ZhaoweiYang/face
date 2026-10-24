// The family-plan upgrade sheet and the join-request sheet from the design.

import { useState } from "preact/hooks";
import { ApiError, api } from "../api";
import { useStore } from "../store";

type Period = "quarter" | "year";

export function UpgradePanel({
  familyId,
  familyName,
  mode,
  onUpgraded,
  onLater,
}: {
  familyId: number;
  familyName: string;
  /** "visitor": a non-member on a standard card; "owner": the admin after the first message, or from the family tab. */
  mode: "visitor" | "owner";
  onUpgraded: () => void;
  onLater?: () => void;
}) {
  const { config } = useStore();
  const [period, setPeriod] = useState<Period>("year");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prices = config?.prices;

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      await api(`/families/${familyId}/upgrade`, { method: "POST", json: { period } });
      onUpgraded();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "payment_unavailable" ? "在线支付暂未开通，请稍后再试" : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="upgrade">
      <p class="lead">
        {mode === "visitor"
          ? `「${familyName}」当前为标准版，仅支持 1 人留言。升级成家庭版，开通多人留言。`
          : `「${familyName}」当前为标准版，仅支持 1 人留言。升级家庭版，邀请家人一起留言。`}
      </p>
      <table class="compare">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">标准版</th>
            <th scope="col" class="hl">家庭版</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">谁能留言</th>
            <td>仅 1 人可留言</td>
            <td class="hl">不限人数的家庭成员均可留言</td>
          </tr>
          <tr>
            <th scope="row">音频</th>
            <td>永久保存</td>
            <td class="hl">永久保存</td>
          </tr>
          <tr>
            <th scope="row">邀请家人</th>
            <td>—</td>
            <td class="hl">邀请链接、审核加入申请</td>
          </tr>
        </tbody>
      </table>
      {prices && (
        <div class="prices" role="radiogroup" aria-label="选择付费方式">
          {(["quarter", "year"] as Period[]).map((p) => (
            <button type="button" role="radio" aria-checked={period === p} class={`price ${period === p ? "is-on" : ""}`} onClick={() => setPeriod(p)} key={p}>
              <span class="price-label">{prices[p].label}价格</span>
              <span class="price-num">
                {prices[p].monthly} <small>元/月</small>
              </span>
              <span class="price-total muted">
                {p === "quarter" ? "每季" : "每年"} {(prices[p].total_fen / 100).toFixed(1)} 元
              </span>
            </button>
          ))}
        </div>
      )}
      {config?.payment_demo && <p class="notice small">测试模式：升级不会实际扣款。</p>}
      {error && <p class="error">{error}</p>}
      <button type="button" class="btn btn-primary btn-block" onClick={buy} disabled={busy}>
        {busy ? "处理中…" : mode === "visitor" ? "立即升级" : "升级并邀请家庭成员"}
      </button>
      {onLater && (
        <button type="button" class="btn btn-ghost btn-block" onClick={onLater}>
          以后再说
        </button>
      )}
    </div>
  );
}

export function ApplyPanel({ cardPath, familyName, onSent }: { cardPath: string; familyName: string; onSent: () => void }) {
  const [identity, setIdentity] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`${cardPath}/apply`, { method: "POST", json: { identity, reason } });
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="form" onSubmit={send}>
      <p class="lead">只有「{familyName}」的家庭成员可以在这里留言。填写申请理由和你的身份，家庭管理员同意后即可留言。</p>
      <label class="field">
        <span>你的身份</span>
        <input id="apply-identity" value={identity} onInput={(e) => setIdentity(e.currentTarget.value)} maxLength={30} placeholder="例如：孙女 小美" required />
      </label>
      <label class="field">
        <span>申请理由</span>
        <textarea id="apply-reason" value={reason} onInput={(e) => setReason(e.currentTarget.value)} maxLength={200} rows={3} placeholder="例如：想给外婆留几句生日祝福" />
      </label>
      {error && <p class="error">{error}</p>}
      <button type="submit" class="btn btn-primary btn-block" disabled={busy || !identity.trim()}>
        {busy ? "发送中…" : "发送申请"}
      </button>
    </form>
  );
}
