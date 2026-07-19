import json, os, time, re, traceback
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, request, Response, jsonify
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, WebDriverException

TOKEN = os.environ.get("NF_WORKER_TOKEN", "change-me")
PORT = int(os.environ.get("PORT", "8787"))
CHROMEDRIVER = os.environ.get("CHROMEDRIVER", "/usr/bin/chromedriver")
CHROME_BIN = os.environ.get("CHROME_BIN", "/usr/bin/google-chrome")
NF_PROXY_URL = os.environ.get("NF_PROXY_URL", "").strip()
ARTIFACT_DIR = Path(os.environ.get("NF_ARTIFACT_DIR", "/home/ubuntu/nfworker_py/artifacts"))
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)

def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def compact(txt, n=700):
    return re.sub(r"\s+", " ", (txt or "")).strip()[:n]

@app.get("/health")
def health():
    return jsonify(ok=True, ts=int(time.time()*1000), engine="selenium", version="2026-07-19-password-route-v2", proxy=bool(NF_PROXY_URL))

def build_driver():
    opts = Options()
    opts.binary_location = CHROME_BIN
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1366,900")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--disable-features=IsolateOrigins,site-per-process")
    opts.add_argument("--lang=en-US,en")
    opts.add_argument("--accept-lang=en-US,en;q=0.9")
    if NF_PROXY_URL:
        opts.add_argument(f"--proxy-server={NF_PROXY_URL}")
    opts.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
    opts.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
    opts.add_experimental_option("useAutomationExtension", False)
    opts.add_experimental_option("prefs", {
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False,
        "intl.accept_languages": "en-US,en",
    })
    drv = webdriver.Chrome(service=Service(CHROMEDRIVER), options=opts)
    try:
        drv.execute_cdp_cmd("Network.setUserAgentOverride", {
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
            "acceptLanguage": "en-US,en;q=0.9",
            "platform": "Windows",
        })
        drv.execute_cdp_cmd("Emulation.setTimezoneOverride", {"timezoneId": "Asia/Kolkata"})
        drv.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": r'''
          Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
          Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
          Object.defineProperty(navigator,'platform',{get:()=> 'Win32'});
          window.chrome = window.chrome || { runtime: {} };
          const origQuery = window.navigator.permissions && window.navigator.permissions.query;
          if (origQuery) window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(parameters)
          );
        '''})
    except Exception:
        pass
    return drv

def visible_enabled(el):
    try:
        return el.is_displayed() and el.is_enabled()
    except Exception:
        return False

def set_input_value(drv, el, value):
    try:
        drv.execute_script("arguments[0].scrollIntoView({block:'center', inline:'center'});", el)
        time.sleep(0.15)
    except Exception:
        pass
    try:
        el.click()
    except Exception:
        try: drv.execute_script("arguments[0].focus();", el)
        except Exception: pass
    try:
        el.send_keys(Keys.CONTROL, "a")
        el.send_keys(Keys.BACKSPACE)
    except Exception:
        pass
    try:
        for ch in value:
            el.send_keys(ch)
            time.sleep(0.018)
        return True, "send_keys"
    except Exception as e:
        try:
            drv.execute_script(
                "const el=arguments[0], v=arguments[1];"
                "const proto=el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;"
                "const setter=Object.getOwnPropertyDescriptor(proto,'value').set;"
                "setter.call(el,v);"
                "el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v}));"
                "el.dispatchEvent(new Event('change',{bubbles:true}));"
                "el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter'}));",
                el, value
            )
            return True, "js-value"
        except Exception as je:
            return False, f"send_keys={e}; js={je}"

def find_first_visible(drv, selectors):
    for sel in selectors:
        try:
            for el in drv.find_elements(By.CSS_SELECTOR, sel):
                if visible_enabled(el):
                    return el, sel
        except Exception:
            continue
    return None, ""

def js_visible_inputs(drv):
    try:
        return drv.execute_script(r'''
          const out=[];
          const walk=(root)=>{
            for (const el of root.querySelectorAll('input,button,a,[role="button"]')) {
              const r=el.getBoundingClientRect(); const cs=getComputedStyle(el);
              if (r.width>0 && r.height>0 && cs.visibility!=='hidden' && cs.display!=='none') {
                out.push({tag:el.tagName, type:el.getAttribute('type'), name:el.getAttribute('name'), id:el.id, uia:el.getAttribute('data-uia'), autocomplete:el.getAttribute('autocomplete'), text:(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').slice(0,80)});
              }
            }
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
          };
          walk(document);
          return out.slice(0,80);
        ''')
    except Exception:
        return []

def body_text(drv, n=900):
    try:
        return compact(drv.find_element(By.TAG_NAME, "body").text, n)
    except Exception:
        return ""

def page_has_bot_block(drv):
    txt = body_text(drv, 1600).lower()
    # Netflix login pages normally contain a static footer sentence:
    # "This page is protected by Google reCAPTCHA...". That is not an
    # active challenge and must not stop the password route.
    hard_text = [
        "select all images", "i'm not a robot", "i am not a robot", "not a robot checkbox",
        "unusual activity", "verify you are human", "verify that you are human",
        "try again in a few minutes", "access denied", "temporarily blocked",
    ]
    if any(x in txt for x in hard_text):
        return True, txt
    try:
        frames = drv.find_elements(By.CSS_SELECTOR, 'iframe[src*="recaptcha"], iframe[title*="recaptcha" i], iframe[title*="challenge" i]')
        visible_frames = [f for f in frames if f.is_displayed()]
        if visible_frames:
            return True, txt
    except Exception:
        pass
    return False, txt

def click_element(drv, el):
    try:
        drv.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        time.sleep(0.1)
    except Exception:
        pass
    try:
        el.click(); return True, "click"
    except Exception:
        try:
            drv.execute_script("arguments[0].click();", el); return True, "js-click"
        except Exception as e:
            return False, str(e)

def click_by_text_or_selector(drv, labels, selectors=None):
    selectors = selectors or []
    for sel in selectors:
        try:
            for el in drv.find_elements(By.CSS_SELECTOR, sel):
                if visible_enabled(el):
                    ok, how = click_element(drv, el)
                    if ok: return True, f"{how}:{sel}"
        except Exception:
            pass
    lower_labels = [x.lower() for x in labels]
    try:
        candidates = drv.find_elements(By.CSS_SELECTOR, "button,a,[role='button'],input[type='submit']")
        for el in candidates:
            if not visible_enabled(el):
                continue
            txt = compact(" ".join([el.text or "", el.get_attribute("value") or "", el.get_attribute("aria-label") or "", el.get_attribute("data-uia") or ""]), 140).lower()
            if any(lbl in txt for lbl in lower_labels):
                ok, how = click_element(drv, el)
                if ok: return True, f"{how}:text={txt[:80]}"
    except Exception:
        pass
    return False, "not-found"

def find_password(drv):
    selectors = [
        'input[name="password"]',
        'input[type="password"]',
        'input#id_password',
        'input[data-uia="login-field-password"]',
        'input[data-uia*="password" i]',
        'input[autocomplete="current-password"]',
        'input[id*="password" i]',
        'input[name*="password" i]',
        'input[aria-label*="password" i]',
        'input[placeholder*="password" i]',
    ]
    return find_first_visible(drv, selectors)

def find_email(drv):
    selectors = [
        'input[name="userLoginId"]',
        'input#id_userLoginId',
        'input[type="email"]',
        'input[inputmode="email"]',
        'input[autocomplete="email"]',
        'input[data-uia="login-field"]',
        'input[aria-label*="email" i]',
        'input[placeholder*="email" i]',
        'input[name*="email" i]',
    ]
    return find_first_visible(drv, selectors)

def save_artifact(drv, tag):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = ARTIFACT_DIR / f"{stamp}-{tag}"
    out = {}
    try:
        png = str(base) + ".png"
        drv.save_screenshot(png)
        out["screenshot"] = png
    except Exception:
        pass
    try:
        html = str(base) + ".html"
        Path(html).write_text(drv.page_source, encoding="utf-8")
        out["html"] = html
    except Exception:
        pass
    return out

@app.post("/login")
def login():
    if request.headers.get("x-worker-token") != TOKEN:
        return jsonify(ok=False, error="unauthorized"), 401
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    mode = body.get("mode") or "password"
    if not email:
        return jsonify(ok=False, error="email required"), 400

    def gen():
        def log(msg):
            yield sse("log", {"ts": now_iso(), "msg": msg})
        drv = None
        try:
            yield from log("Launching headless Chromium (Selenium v2 password-route)")
            drv = build_driver()
            drv.set_page_load_timeout(90)
            wait = WebDriverWait(drv, 35)
            yield from log("Opening netflix.com/login")
            drv.get("https://www.netflix.com/login")
            time.sleep(2.0)
            yield from log("Page URL: " + drv.current_url)

            # Cookie/privacy banner best-effort.
            ok, how = click_by_text_or_selector(drv, ["accept", "agree"], [
                'button[data-uia="cookie-disclosure-button-accept"]',
                '#onetrust-accept-btn-handler',
                'button[mode="primary"]',
            ])
            if ok:
                yield from log("Accepted cookie/banner via " + how)
                time.sleep(0.7)

            blocked, txt = page_has_bot_block(drv)
            if blocked:
                art = save_artifact(drv, "blocked-on-open")
                yield from log("Netflix bot/security page before typing: " + compact(txt, 420))
                yield sse("result", {"ok": False, "stage": "netflix_security_block", "url": drv.current_url, "error": "Netflix security/reCAPTCHA page shown before login", "artifact": art})
                return

            yield from log(f"Typing email: {email}")
            email_el, email_sel = find_email(drv)
            if not email_el:
                art = save_artifact(drv, "no-email-field")
                yield from log("Email field not found. Visible controls: " + json.dumps(js_visible_inputs(drv)[:20], ensure_ascii=False))
                yield sse("result", {"ok": False, "stage": "no_email_field", "url": drv.current_url, "bodyText": body_text(drv), "artifact": art})
                return
            ok, how = set_input_value(drv, email_el, email)
            yield from log(f"Email typed via {how} selector={email_sel}")
            time.sleep(0.4)

            if mode == "email_only" or not password:
                yield from log("Submitting email only")
                ok, how = click_by_text_or_selector(drv, ["next", "continue", "sign in", "send"], ['button[data-uia="login-submit-button"]', 'button[type="submit"]'])
                if not ok: email_el.send_keys(Keys.ENTER)
                time.sleep(4)
                yield sse("result", {"ok": False, "stage": "email_only", "url": drv.current_url})
                return

            # Netflix /in/login is a two-step page. Submit the email once, then wait.
            # Do not repeatedly click the generic Continue button: if Netflix rejects/clears
            # the email, repeated clicks keep us on the email page and hide the real state.
            yield from log("Submitting email once and waiting for password/sign-in route")
            clicked, how = click_by_text_or_selector(drv, ["continue", "next", "sign in"], [
                'button[data-uia="login-submit-button"]',
                'button[type="submit"]',
                'input[type="submit"]',
            ])
            yield from log(f"Email submit clicked={clicked} via {how}")
            if not clicked:
                try:
                    email_el.send_keys(Keys.ENTER)
                    yield from log("Email submitted via ENTER")
                except Exception as e:
                    yield from log("Email ENTER submit failed: " + str(e))

            pw_el, pw_sel = None, ""
            deadline = time.time() + 28
            password_route_clicked = False
            last_signature = ""
            while time.time() < deadline:
                pw_el, pw_sel = find_password(drv)
                if pw_el:
                    yield from log(f"Password field visible selector={pw_sel}")
                    break

                blocked, txt = page_has_bot_block(drv)
                if blocked:
                    art = save_artifact(drv, "blocked-after-email")
                    yield from log("Netflix security/reCAPTCHA after email: " + compact(txt, 520))
                    yield sse("result", {"ok": False, "stage": "netflix_security_block", "url": drv.current_url, "error": "Netflix security/reCAPTCHA page shown after email", "bodyText": compact(txt, 700), "artifact": art})
                    return

                # If Netflix lands on OTP/code flow, click only explicit password controls.
                controls = js_visible_inputs(drv)
                sig = json.dumps(controls[:12], ensure_ascii=False)
                if sig != last_signature:
                    yield from log("Visible controls while waiting: " + sig[:900])
                    last_signature = sig
                if not password_route_clicked:
                    clicked_pw, how_pw = click_by_text_or_selector(drv, [
                        "use password", "password instead", "sign in with password", "signin with password", "log in with password",
                        "use your password", "enter password"
                    ], [
                        'a[data-uia*="password" i]',
                        'button[data-uia*="password" i]',
                        '[role="button"][data-uia*="password" i]',
                    ])
                    if clicked_pw:
                        password_route_clicked = True
                        yield from log("Clicked explicit password route via " + how_pw)
                time.sleep(1.0)

            if not pw_el:
                art = save_artifact(drv, "no-password-field")
                controls = js_visible_inputs(drv)
                txt = body_text(drv, 1100)
                yield from log("Password field not found. Visible controls: " + json.dumps(controls[:35], ensure_ascii=False))
                yield from log("Page text: " + compact(txt, 600))
                # If Netflix only offers OTP/code, this is not a selector failure.
                stage = "otp_or_code_flow" if re.search(r"code|otp|verification|send.*code|email.*code", txt, re.I) else "no_password_field"
                yield sse("result", {"ok": False, "stage": stage, "url": drv.current_url, "bodyText": txt, "visibleControls": controls[:35], "artifact": art})
                return

            yield from log(f"Typing password into selector={pw_sel} (len={len(password)})")
            ok, how = set_input_value(drv, pw_el, password)
            if not ok:
                art = save_artifact(drv, "password-type-failed")
                yield sse("result", {"ok": False, "stage": "password_type_failed", "url": drv.current_url, "error": how, "artifact": art})
                return
            yield from log(f"Password typed successfully via {how}")
            time.sleep(0.5)

            yield from log("Submitting login form")
            clicked, click_how = click_by_text_or_selector(drv, ["sign in", "continue", "next"], ['button[data-uia="login-submit-button"]', 'button[type="submit"]'])
            yield from log(f"Submit click result clicked={clicked} via {click_how}")
            if not clicked:
                pw_el.send_keys(Keys.ENTER)

            yield from log("Waiting for navigation/session result")
            deadline = time.time() + 35
            last_url = ""
            while time.time() < deadline:
                url = drv.current_url
                if url != last_url:
                    yield from log("Current URL: " + url)
                    last_url = url
                blocked, txt = page_has_bot_block(drv)
                if blocked:
                    art = save_artifact(drv, "blocked-after-password")
                    yield from log("Netflix security/reCAPTCHA after password submit: " + compact(txt, 520))
                    yield sse("result", {"ok": False, "stage": "netflix_security_block", "url": url, "error": "Netflix security/reCAPTCHA page shown after password submit", "bodyText": compact(txt, 700), "artifact": art})
                    return
                if re.search(r"/(browse|profiles|watch|kids|YourAccount)", url, re.I):
                    break
                # Also break when a clear password/login error appears.
                body = body_text(drv, 900)
                if re.search(r"incorrect|wrong password|can.t find|try again|temporarily unavailable", body, re.I):
                    break
                time.sleep(0.7)

            url = drv.current_url
            yield from log("URL after submit: " + url)
            if "/login" in url:
                try:
                    err_nodes = drv.find_elements(By.CSS_SELECTOR, '[data-uia*="error"], .ui-message-contents, [class*="error"], [role="alert"]')
                    visible_err = " | ".join([compact(e.text, 250) for e in err_nodes if e.is_displayed() and compact(e.text, 250)])
                except Exception:
                    visible_err = ""
                yield from log("Still on login page. Error: " + (visible_err or "(none visible)"))
                yield from log("Trying direct /browse to check if session cookie was already set")
                try: drv.get("https://www.netflix.com/browse")
                except Exception: pass
                time.sleep(3)
                url = drv.current_url
                yield from log("After /browse: " + url)

            signed_in = bool(re.search(r"/(browse|profiles|watch|kids|YourAccount)", url, re.I))
            raw = drv.get_cookies()
            nf = [c for c in raw if str(c.get("domain", "")).endswith("netflix.com")]
            names = {c.get("name") for c in nf}
            has_key = ("NetflixId" in names) and ("SecureNetflixId" in names)
            yield from log(f"signed_in={signed_in} netflix_cookies={len(nf)} keys={has_key} names={','.join(sorted([x for x in names if x])[:30])}")

            norm = []
            for c in nf:
                norm.append({
                    "name": c.get("name"),
                    "value": c.get("value"),
                    "domain": c.get("domain"),
                    "path": c.get("path", "/"),
                    "expires": c.get("expiry", -1),
                    "httpOnly": bool(c.get("httpOnly", False)),
                    "secure": bool(c.get("secure", False)),
                    "sameSite": c.get("sameSite", "Lax"),
                })
            ok = signed_in and has_key
            if not ok:
                art = save_artifact(drv, "not-signed-in")
            else:
                art = {}
            yield sse("result", {"ok": ok, "url": url, "cookies": norm, "signedIn": signed_in, "hasKey": has_key, "stage": "done" if ok else "not_signed_in", "artifact": art})
        except Exception as e:
            try:
                art = save_artifact(drv, "fatal") if drv else {}
            except Exception:
                art = {}
            yield sse("log", {"ts": now_iso(), "msg": "FATAL: " + str(e)})
            yield sse("log", {"ts": now_iso(), "msg": traceback.format_exc()[-1800:]})
            yield sse("result", {"ok": False, "stage": "fatal", "error": str(e), "artifact": art})
        finally:
            try:
                if drv: drv.quit()
            except Exception:
                pass

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, threaded=True)
