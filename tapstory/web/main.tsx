import { render } from "preact";
import { useEffect } from "preact/hooks";
import { CardPage } from "./pages/Card";
import { HomePage } from "./pages/Home";
import { JoinPage } from "./pages/Join";
import { LoginPage } from "./pages/Login";
import { onLinkClick, useLocation } from "./router";
import { boot, useStore } from "./store";
import { Icon, Spinner } from "./ui";
import "./style.css";

/** Only same-site paths may be a post-login destination. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/app";
}

function Landing() {
  const { me } = useStore();
  return (
    <main class="page center-page">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true" />
        <h1>TapStory</h1>
        <p class="muted">碰一碰照片背后的卡片，听见家人的声音。</p>
      </div>
      <a class="btn btn-primary btn-block btn-big" href={me ? "/app" : "/login?next=/app"}>
        {me ? "进入我的家庭" : "登录"}
      </a>
    </main>
  );
}

function App() {
  const url = useLocation();
  const { ready, toast } = useStore();
  useEffect(() => {
    document.addEventListener("click", onLinkClick);
    return () => document.removeEventListener("click", onLinkClick);
  }, []);

  const p = url.pathname;
  let page;
  let m: RegExpMatchArray | null;
  if (!ready) page = <Spinner />;
  else if ((m = p.match(/^\/c\/([^/]+)\/?$/))) page = <CardPage kind="t" cardRef={m[1]} />;
  else if ((m = p.match(/^\/app\/cards\/(\d+)\/?$/))) page = <CardPage kind="i" cardRef={m[1]} />;
  else if (p === "/app" || p === "/app/") page = <HomePage url={url} />;
  else if ((m = p.match(/^\/join\/([^/]+)\/?$/))) page = <JoinPage token={m[1]} />;
  else if (p === "/login") page = <LoginPage next={safeNext(url.searchParams.get("next"))} />;
  else if (p === "/") page = <Landing />;
  else
    page = (
      <main class="page center-page">
        <div class="empty">
          <div class="empty-mark" aria-hidden="true">
            <Icon name="wave" />
          </div>
          <h1>页面不存在</h1>
        </div>
      </main>
    );

  return (
    <>
      {page}
      {toast && (
        <div class="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

boot();
render(<App />, document.getElementById("root")!);
