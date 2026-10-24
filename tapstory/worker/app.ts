// Cards, families, membership requests, invites and voice messages.
//
// Card rules (from the product flow):
// - An unactivated card is bound to one of the signed-in user's families ("激活").
// - Anyone with the card URL can play its messages; recording needs a signed-in member.
// - Standard plan: only the family admin records ("仅 1 人可留言").
// - Family plan: every member records; non-members can apply to join from a card.

import { HttpError, clientIp, json, limit, now, readJson, str } from "./http";
import type { User } from "./auth";
import { TOKEN_RE, hashToken, newToken, sniffAudio } from "./security";

export const PRICES = {
  quarter: { monthly: 9.9, total_fen: 2970, days: 92, label: "季付" },
  year: { monthly: 6.9, total_fen: 8280, days: 366, label: "年付" },
} as const;

type Role = "admin" | "member";

interface Card {
  id: number;
  name: string;
  family_id: number | null;
  family_name: string | null;
  plan_until: number | null;
}

interface Family {
  id: number;
  name: string;
  plan_until: number;
  created_by: number;
}

/** A card reached either by its secret URL token ("t") or, for family members, by id ("i"). */
export interface CardRef {
  kind: "t" | "i";
  ref: string;
}

const planActive = (planUntil: number | null | undefined) => (planUntil ?? 0) > now();

export class App {
  constructor(
    readonly env: Env,
    readonly request: Request,
    readonly user: User | null,
  ) {}

  get db() {
    return this.env.DB;
  }

  requireUser(): User {
    if (!this.user) throw new HttpError(401, "请先登录", "login_required");
    return this.user;
  }

  async role(familyId: number | null, userId = this.user?.id): Promise<Role | null> {
    if (!familyId || !userId) return null;
    return this.db
      .prepare("SELECT role FROM family_members WHERE family_id = ? AND user_id = ?")
      .bind(familyId, userId)
      .first<Role>("role");
  }

  async family(id: number): Promise<Family> {
    const f = await this.db.prepare("SELECT id, name, plan_until, created_by FROM families WHERE id = ?").bind(id).first<Family>();
    if (!f) throw new HttpError(404, "家庭不存在");
    return f;
  }

  async requireRole(familyId: number, needed: Role): Promise<Role> {
    const role = await this.role(familyId, this.requireUser().id);
    if (!role || (needed === "admin" && role !== "admin")) {
      throw new HttpError(403, needed === "admin" ? "只有家庭管理员可以操作" : "你不是这个家庭的成员");
    }
    return role;
  }

  // --- cards ----------------------------------------------------------------

  /** Unknown and malformed tokens look identical; each miss counts against the IP. */
  async loadCard({ kind, ref }: CardRef): Promise<Card> {
    const sql =
      "SELECT cards.id, cards.name, cards.family_id, families.name AS family_name, families.plan_until " +
      "FROM cards LEFT JOIN families ON families.id = cards.family_id WHERE cards.revoked = 0 AND ";
    let card: Card | null = null;
    if (kind === "t" && TOKEN_RE.test(ref)) {
      card = await this.db.prepare(sql + "cards.token_hash = ?").bind(await hashToken(ref)).first<Card>();
    } else if (kind === "i" && /^\d{1,12}$/.test(ref) && this.user) {
      card = await this.db.prepare(sql + "cards.id = ?").bind(Number(ref)).first<Card>();
      if (card && !(await this.role(card.family_id))) card = null;
    }
    if (!card) {
      const { success } = await this.env.RL_MISS.limit({ key: clientIp(this.request) });
      throw success ? new HttpError(404, "卡片不存在") : new HttpError(429, "访问过于频繁，请稍后再试");
    }
    return card;
  }

  async cardView(ref: CardRef): Promise<Response> {
    const card = await this.loadCard(ref);
    const me = this.user;
    const base = `/api/cards/${ref.kind}/${ref.ref}`;
    const limits = {
      max_seconds: Number(this.env.MAX_SECONDS),
      max_bytes: Number(this.env.MAX_AUDIO_MB) * 1024 * 1024,
    };

    if (card.family_id === null) {
      // Not activated yet: offer the user's families to bind it to.
      const families = me ? await this.myFamilies(me.id) : [];
      return json({ card: { id: null, name: "", activated: false, family: null }, me: this.meOut(), families, limits });
    }

    const role = await this.role(card.family_id);
    const plan = planActive(card.plan_until) ? "family" : "standard";
    const { results } = await this.db
      .prepare(
        "SELECT messages.id, messages.author_id, messages.duration, messages.created_at, users.name, users.avatar_url, " +
          "family_members.nickname FROM messages JOIN users ON users.id = messages.author_id " +
          "LEFT JOIN family_members ON family_members.family_id = ? AND family_members.user_id = messages.author_id " +
          "WHERE messages.card_id = ? ORDER BY messages.created_at",
      )
      .bind(card.family_id, card.id)
      .all<{ id: string; author_id: number; duration: number; created_at: number; name: string; avatar_url: string; nickname: string | null }>();

    let block: string | null = null;
    let application: string | null = null;
    if (!me) block = "login";
    else if (!role) {
      application = await this.db
        .prepare("SELECT status FROM applications WHERE family_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1")
        .bind(card.family_id, me.id)
        .first<string>("status");
      block = application === "pending" ? "pending" : plan === "family" ? "apply" : "upgrade";
    } else if (role !== "admin" && plan !== "family") block = "plan_expired";

    return json({
      card: {
        id: role ? card.id : null,
        name: card.name,
        activated: true,
        family: { id: card.family_id, name: card.family_name, plan },
      },
      me: this.meOut(),
      role,
      can_record: block === null,
      record_block: block,
      messages: results.map((m) => ({
        id: m.id,
        author: { name: m.nickname || m.name || "家人", avatar: m.avatar_url },
        mine: me?.id === m.author_id,
        can_delete: me?.id === m.author_id || role === "admin",
        created_at: m.created_at,
        duration: m.duration,
        url: `${base}/messages/${m.id}/audio`,
      })),
      limits,
    });
  }

  meOut() {
    const u = this.user;
    return u ? { id: u.id, name: u.name, email: u.email, avatar: u.avatar_url } : null;
  }

  async myFamilies(userId: number) {
    const { results } = await this.db
      .prepare(
        "SELECT families.id, families.name, families.plan_until, family_members.role FROM family_members " +
          "JOIN families ON families.id = family_members.family_id WHERE family_members.user_id = ? ORDER BY family_members.joined_at",
      )
      .bind(userId)
      .all<{ id: number; name: string; plan_until: number; role: Role }>();
    return results.map((f) => ({ id: f.id, name: f.name, role: f.role, plan: planActive(f.plan_until) ? "family" : "standard", plan_until: f.plan_until }));
  }

  async createFamily(userId: number, rawName: unknown): Promise<number> {
    const name = str(rawName, 30);
    if (!name) throw new HttpError(400, "请输入家庭名称");
    const t = now();
    const id = await this.db
      .prepare("INSERT INTO families (name, created_by, created_at) VALUES (?, ?, ?) RETURNING id")
      .bind(name, userId, t)
      .first<number>("id");
    await this.db
      .prepare("INSERT INTO family_members (family_id, user_id, role, nickname, joined_at) VALUES (?, ?, 'admin', '', ?)")
      .bind(id, userId, t)
      .run();
    return id!;
  }

  async activate(token: string): Promise<Response> {
    const user = this.requireUser();
    const card = await this.loadCard({ kind: "t", ref: token });
    if (card.family_id !== null) throw new HttpError(409, "这张卡片已经激活");
    const body = await readJson<{ family_id: number; family_name: string; card_name: string }>(this.request);
    let familyId = Number(body.family_id);
    if (body.family_name !== undefined && !familyId) familyId = await this.createFamily(user.id, body.family_name);
    else await this.requireRole(familyId, "member");
    const res = await this.db
      .prepare("UPDATE cards SET family_id = ?, activated_by = ?, activated_at = ?, name = ? WHERE id = ? AND family_id IS NULL")
      .bind(familyId, user.id, now(), str(body.card_name, 40), card.id)
      .run();
    if (res.meta.changes !== 1) throw new HttpError(409, "这张卡片已经激活");
    return json({ ok: true, family_id: familyId });
  }

  async renameCard(ref: CardRef): Promise<Response> {
    const card = await this.loadCard(ref);
    await this.requireRole(card.family_id!, "member");
    const name = str((await readJson<{ name: string }>(this.request)).name, 40);
    await this.db.prepare("UPDATE cards SET name = ? WHERE id = ?").bind(name, card.id).run();
    return json({ name });
  }

  // --- messages ---------------------------------------------------------------

  async upload(ref: CardRef): Promise<Response> {
    const user = this.requireUser();
    const card = await this.loadCard(ref);
    if (card.family_id === null) throw new HttpError(409, "请先激活这张卡片");
    const role = await this.requireRole(card.family_id, "member");
    const familyPlan = planActive(card.plan_until);
    if (role !== "admin" && !familyPlan) throw new HttpError(403, "标准版仅支持 1 人留言，请联系家庭管理员升级家庭版", "plan_required");
    await limit(this.env.RL_UPLOAD, String(user.id), "上传过于频繁，请稍后再试");

    const maxBytes = Number(this.env.MAX_AUDIO_MB) * 1024 * 1024;
    if (Number(this.request.headers.get("Content-Length") ?? 0) > maxBytes + 64 * 1024) throw new HttpError(413, "录音太长了");
    let form: FormData;
    try {
      form = await this.request.formData();
    } catch {
      throw new HttpError(400, "请求格式错误");
    }
    const file = form.get("audio");
    if (!file || typeof file === "string") throw new HttpError(400, "缺少录音");
    if (file.size > maxBytes) throw new HttpError(413, "录音太长了");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffAudio(bytes.subarray(0, 16));
    if (!kind) throw new HttpError(415, "不支持的音频格式");
    const [mime, ext] = kind;
    const maxSeconds = Number(this.env.MAX_SECONDS);
    const raw = Number(form.get("duration") ?? 0);
    const duration = Number.isFinite(raw) ? Math.round(Math.min(Math.max(raw, 0), maxSeconds + 5) * 10) / 10 : 0;

    const id = newToken(12);
    const key = `audio/${card.id}/${id}.${ext}`;
    await this.env.AUDIO.put(key, bytes, { httpMetadata: { contentType: mime } });
    await this.db
      .prepare("INSERT INTO messages (id, card_id, author_id, r2_key, mime, size, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, card.id, user.id, key, mime, bytes.length, duration, now())
      .run();
    const count = await this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE card_id = ?").bind(card.id).first<number>("n");
    // "若当前家庭未升级套餐，每张卡首次留言成功后" offer the family plan.
    return json({ id, upsell: !familyPlan && role === "admin" && count === 1, family_id: card.family_id });
  }

  async message(card: Card, id: string) {
    const m = await this.db
      .prepare("SELECT id, author_id, r2_key, mime, size FROM messages WHERE id = ? AND card_id = ?")
      .bind(id, card.id)
      .first<{ id: string; author_id: number; r2_key: string; mime: string; size: number }>();
    if (!m) throw new HttpError(404, "留言不存在");
    return m;
  }

  async deleteMessage(ref: CardRef, id: string): Promise<Response> {
    const user = this.requireUser();
    const card = await this.loadCard(ref);
    const m = await this.message(card, id);
    const role = await this.role(card.family_id);
    if (m.author_id !== user.id && role !== "admin") throw new HttpError(403, "只能删除自己的留言");
    await this.db.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
    await this.env.AUDIO.delete(m.r2_key);
    return json({ ok: true });
  }

  /** Streams audio from R2; Range support is required for playback in iOS Safari. */
  async audio(ref: CardRef, id: string): Promise<Response> {
    const card = await this.loadCard(ref);
    const m = await this.message(card, id);
    const ranged = this.request.headers.has("Range");
    let object: R2ObjectBody | R2Object | null;
    try {
      object = await this.env.AUDIO.get(m.r2_key, ranged ? { range: this.request.headers } : undefined);
    } catch {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${m.size}` } });
    }
    if (!object || !("body" in object)) throw new HttpError(404, "留言不存在");
    const headers = new Headers({
      "Content-Type": m.mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400",
      ETag: object.httpEtag,
    });
    let status = 200;
    let length = object.size;
    if (ranged && object.range) {
      const r = object.range as { offset?: number; length?: number; suffix?: number };
      const offset = r.suffix !== undefined ? object.size - r.suffix : (r.offset ?? 0);
      length = r.suffix !== undefined ? r.suffix : (r.length ?? object.size - offset);
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      status = 206;
    }
    headers.set("Content-Length", String(length));
    return new Response(this.request.method === "HEAD" ? null : object.body, { status, headers });
  }

  // --- joining a family ---------------------------------------------------------

  async apply(ref: CardRef): Promise<Response> {
    const user = this.requireUser();
    const card = await this.loadCard(ref);
    if (card.family_id === null) throw new HttpError(409, "这张卡片还没有激活");
    if (await this.role(card.family_id)) throw new HttpError(409, "你已经是这个家庭的成员");
    if (!planActive(card.plan_until)) throw new HttpError(409, "这个家庭还没有开通家庭版", "upgrade_required");
    const body = await readJson<{ identity: string; reason: string }>(this.request);
    const identity = str(body.identity, 30);
    if (!identity) throw new HttpError(400, "请填写你的身份，例如：孙女 小美");
    const pending = await this.db
      .prepare("SELECT id FROM applications WHERE family_id = ? AND user_id = ? AND status = 'pending'")
      .bind(card.family_id, user.id)
      .first<number>("id");
    if (pending) return json({ ok: true, id: pending });
    const id = await this.db
      .prepare("INSERT INTO applications (family_id, user_id, card_id, identity, reason, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(card.family_id, user.id, card.id, identity, str(body.reason, 200), now())
      .first<number>("id");
    return json({ ok: true, id });
  }

  async decide(familyId: number, appId: number, approve: boolean): Promise<Response> {
    await this.requireRole(familyId, "admin");
    const app = await this.db
      .prepare("SELECT user_id, identity FROM applications WHERE id = ? AND family_id = ? AND status = 'pending'")
      .bind(appId, familyId)
      .first<{ user_id: number; identity: string }>();
    if (!app) throw new HttpError(404, "申请不存在或已处理");
    if (approve && !planActive((await this.family(familyId)).plan_until)) throw new HttpError(409, "家庭版已到期，续费后才能添加成员", "upgrade_required");
    const stmts = [
      this.db.prepare("UPDATE applications SET status = ?, decided_at = ? WHERE id = ?").bind(approve ? "approved" : "rejected", now(), appId),
    ];
    if (approve) {
      stmts.push(
        this.db
          .prepare("INSERT OR IGNORE INTO family_members (family_id, user_id, role, nickname, joined_at) VALUES (?, ?, 'member', ?, ?)")
          .bind(familyId, app.user_id, app.identity, now()),
      );
    }
    await this.db.batch(stmts);
    return json({ ok: true });
  }

  async createInvite(familyId: number): Promise<Response> {
    await this.requireRole(familyId, "admin");
    if (!planActive((await this.family(familyId)).plan_until)) throw new HttpError(409, "升级家庭版后才能邀请成员", "upgrade_required");
    const token = newToken();
    await this.db
      .prepare("INSERT INTO invites (token_hash, family_id, created_by, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await hashToken(token), familyId, this.user!.id, now() + 7 * 86400)
      .run();
    return json({ url: `${new URL(this.request.url).origin}/join/${token}`, expires_in_days: 7 });
  }

  async invite(token: string) {
    const inv = TOKEN_RE.test(token)
      ? await this.db
          .prepare(
            "SELECT invites.family_id, families.name, families.plan_until FROM invites JOIN families ON families.id = invites.family_id " +
              "WHERE invites.token_hash = ? AND invites.expires_at > ?",
          )
          .bind(await hashToken(token), now())
          .first<{ family_id: number; name: string; plan_until: number }>()
      : null;
    if (!inv) {
      await limit(this.env.RL_MISS, clientIp(this.request), "访问过于频繁，请稍后再试");
      throw new HttpError(404, "邀请链接无效或已过期");
    }
    return inv;
  }

  async inviteView(token: string): Promise<Response> {
    const inv = await this.invite(token);
    return json({ family: { id: inv.family_id, name: inv.name }, member: Boolean(await this.role(inv.family_id)), me: this.meOut() });
  }

  async acceptInvite(token: string): Promise<Response> {
    const user = this.requireUser();
    const inv = await this.invite(token);
    if (!planActive(inv.plan_until)) throw new HttpError(409, "这个家庭的家庭版已到期，请联系管理员续费");
    const nickname = str((await readJson<{ nickname: string }>(this.request)).nickname, 30);
    await this.db
      .prepare("INSERT OR IGNORE INTO family_members (family_id, user_id, role, nickname, joined_at) VALUES (?, ?, 'member', ?, ?)")
      .bind(inv.family_id, user.id, nickname, now())
      .run();
    return json({ ok: true, family_id: inv.family_id });
  }

  // --- families -------------------------------------------------------------------

  async familyView(familyId: number): Promise<Response> {
    const role = await this.requireRole(familyId, "member");
    const f = await this.family(familyId);
    const members = await this.db
      .prepare(
        "SELECT users.id, users.name, users.email, users.avatar_url, family_members.role, family_members.nickname " +
          "FROM family_members JOIN users ON users.id = family_members.user_id WHERE family_members.family_id = ? " +
          "ORDER BY family_members.role = 'admin' DESC, family_members.joined_at",
      )
      .bind(familyId)
      .all<{ id: number; name: string; email: string | null; avatar_url: string; role: Role; nickname: string }>();
    const cards = await this.db
      .prepare(
        "SELECT cards.id, cards.name, COUNT(messages.id) AS messages, MAX(messages.created_at) AS last_at FROM cards " +
          "LEFT JOIN messages ON messages.card_id = cards.id WHERE cards.family_id = ? AND cards.revoked = 0 " +
          "GROUP BY cards.id ORDER BY cards.activated_at DESC",
      )
      .bind(familyId)
      .all<{ id: number; name: string; messages: number; last_at: number | null }>();
    const applications =
      role === "admin"
        ? (
            await this.db
              .prepare(
                "SELECT applications.id, applications.identity, applications.reason, applications.created_at, users.name, users.email, " +
                  "users.avatar_url, cards.name AS card_name FROM applications JOIN users ON users.id = applications.user_id " +
                  "LEFT JOIN cards ON cards.id = applications.card_id WHERE applications.family_id = ? AND applications.status = 'pending' " +
                  "ORDER BY applications.created_at",
              )
              .bind(familyId)
              .all()
          ).results
        : [];
    return json({
      family: { id: f.id, name: f.name, plan: planActive(f.plan_until) ? "family" : "standard", plan_until: f.plan_until },
      role,
      members: members.results.map((m) => ({
        id: m.id,
        name: m.nickname || m.name,
        account: m.name,
        email: role === "admin" ? m.email : null,
        avatar: m.avatar_url,
        role: m.role,
        me: m.id === this.user!.id,
      })),
      cards: cards.results,
      applications,
    });
  }

  async updateFamily(familyId: number): Promise<Response> {
    await this.requireRole(familyId, "admin");
    const name = str((await readJson<{ name: string }>(this.request)).name, 30);
    if (!name) throw new HttpError(400, "请输入家庭名称");
    await this.db.prepare("UPDATE families SET name = ? WHERE id = ?").bind(name, familyId).run();
    return json({ name });
  }

  async updateMember(familyId: number, userId: number): Promise<Response> {
    const myRole = await this.requireRole(familyId, "member");
    if (userId !== this.user!.id && myRole !== "admin") throw new HttpError(403, "只能修改自己的称呼");
    const nickname = str((await readJson<{ nickname: string }>(this.request)).nickname, 30);
    await this.db.prepare("UPDATE family_members SET nickname = ? WHERE family_id = ? AND user_id = ?").bind(nickname, familyId, userId).run();
    return json({ nickname });
  }

  async removeMember(familyId: number, userId: number): Promise<Response> {
    const myRole = await this.requireRole(familyId, "member");
    const self = userId === this.user!.id;
    if (!self && myRole !== "admin") throw new HttpError(403, "只有家庭管理员可以移除成员");
    if ((await this.role(familyId, userId)) === "admin") throw new HttpError(409, "管理员不能退出或被移除");
    await this.db.prepare("DELETE FROM family_members WHERE family_id = ? AND user_id = ?").bind(familyId, userId).run();
    return json({ ok: true });
  }

  /** Buying the family plan. Anyone signed in may pay for a family (e.g. a gift from a visitor). */
  async upgrade(familyId: number): Promise<Response> {
    const user = this.requireUser();
    const f = await this.family(familyId);
    const period = (await readJson<{ period: string }>(this.request)).period;
    if (period !== "quarter" && period !== "year") throw new HttpError(400, "请选择套餐");
    if (this.env.PAYMENT_MODE !== "demo") throw new HttpError(501, "在线支付尚未开通", "payment_unavailable");
    const price = PRICES[period];
    const until = Math.max(now(), f.plan_until) + price.days * 86400;
    await this.db.batch([
      this.db
        .prepare("INSERT INTO orders (family_id, user_id, period, amount_fen, provider, status, created_at) VALUES (?, ?, ?, ?, 'demo', 'paid', ?)")
        .bind(familyId, user.id, period, price.total_fen, now()),
      this.db.prepare("UPDATE families SET plan_until = ? WHERE id = ?").bind(until, familyId),
    ]);
    return json({ plan: "family", plan_until: until });
  }

  // --- me -------------------------------------------------------------------------

  async me(): Promise<Response> {
    const me = this.meOut();
    return json({ me, families: me ? await this.myFamilies(me.id) : [] });
  }

  async updateMe(): Promise<Response> {
    const user = this.requireUser();
    const name = str((await readJson<{ name: string }>(this.request)).name, 40);
    if (!name) throw new HttpError(400, "请输入名字");
    await this.db.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, user.id).run();
    return json({ name });
  }

  async newFamily(): Promise<Response> {
    const user = this.requireUser();
    const id = await this.createFamily(user.id, (await readJson<{ name: string }>(this.request)).name);
    return json({ id });
  }
}
