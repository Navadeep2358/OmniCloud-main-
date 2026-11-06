import { useState } from "react";
import { ArrowRight, Cloud, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, X } from "lucide-react";

async function request(path, values) {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(values),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || "We couldn’t complete that request. Please try again.");
    error.code = result.code;
    throw error;
  }
  return result;
}

function passwordIssue(password) {
  if (password.length < 12) return "Use at least 12 characters.";
  if (!/[a-z]/.test(password)) return "Add at least one lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Add at least one uppercase letter.";
  if (!/[0-9]/.test(password)) return "Add at least one number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Add at least one symbol.";
  return "";
}

export default function AuthModal({ onClose, initialMode = "login" }) {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [busy, setBusy] = useState(false);

  function changeMode(nextMode) {
    setMode(nextMode);
    setMessage("");
    setPassword("");
    setConfirmPassword("");
    setCode("");
  }

  function announce(text, type = "success") {
    setMessage(text);
    setMessageType(type);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setMessage("");

    if ((mode === "register" || mode === "reset") && passwordIssue(password)) {
      announce(passwordIssue(password), "error");
      return;
    }
    if ((mode === "register" || mode === "reset") && password !== confirmPassword) {
      announce("Those passwords don’t match.", "error");
      return;
    }

    setBusy(true);
    try {
      if (mode === "login") {
        await request("login", { email, password });
        window.location.assign("/workspace");
        return;
      }
      if (mode === "register") {
        await request("register", { name, mobile, email, password });
        changeMode("verify");
        announce("We sent a 6-digit verification code to your email.");
        return;
      }
      if (mode === "verify") {
        await request("verify-email", { email, code });
        window.location.assign("/workspace");
        return;
      }
      if (mode === "forgot") {
        await request("forgot-password", { email });
        changeMode("reset");
        announce("If an account uses this email, a password reset code is on its way.");
        return;
      }
      await request("reset-password", { email, code, password });
      changeMode("login");
      announce("Your password has been updated. Sign in with your new password.");
    } catch (error) {
      if (error.code === "EMAIL_NOT_VERIFIED") {
        setMode("verify");
        announce("Verify your email to finish signing in. You can request a new code below.", "error");
      } else {
        announce(error.message, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true);
    try {
      await request("resend-verification", { email });
      announce("If the account is waiting for verification, a fresh code has been sent.");
    } catch (error) {
      announce(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  const heading = {
    login: "Welcome back.",
    register: "Create your account.",
    verify: "Check your inbox.",
    forgot: "Reset your password.",
    reset: "Choose a new password.",
  }[mode];
  const descriptions = {
    login: "Sign in to access your infrastructure workspace.",
    register: "Create an account to get started with OmniCloud.",
    verify: `Enter the 6-digit code sent to ${email || "your email"}.`,
    forgot: "Enter your account email and we’ll send a reset code.",
    reset: `Enter the code sent to ${email || "your email"} and choose a new password.`,
  }[mode];

  return (
    <div className="omni-modal-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="omni-login-modal" role="dialog" aria-modal="true" aria-labelledby="omni-login-title">
        <button type="button" className="omni-modal-close" onClick={onClose} aria-label="Close">
          <X size={22} />
        </button>
        <a className="omni-brand" href="#home" aria-label="OmniCloud home" onClick={onClose}>
          <span className="omni-brand-icon"><Cloud size={25} /></span>
          <span className="omni-brand-name">Omni<span>Cloud</span></span>
        </a>

        <div className="omni-modal-intro">
          <div className="omni-eyebrow">OMNICLOUD WORKSPACE</div>
          <h2 id="omni-login-title">{heading}</h2>
          <p>{descriptions}</p>
        </div>

        <form className="omni-auth-form" onSubmit={handleSubmit}>
          {mode === "register" && (
            <>
              <label htmlFor="omni-auth-name">Full name</label>
              <div className="omni-input-wrapper">
                <input id="omni-auth-name" type="text" autoComplete="name" maxLength={120}
                  placeholder="Your name" value={name}
                  onChange={(event) => setName(event.target.value)} required />
              </div>
              <label htmlFor="omni-auth-mobile">Mobile number</label>
              <div className="omni-input-wrapper">
                <input id="omni-auth-mobile" type="tel" autoComplete="tel" inputMode="tel"
                  maxLength={20} placeholder="+91 98765 43210" value={mobile}
                  onChange={(event) => setMobile(event.target.value)} required />
              </div>
            </>
          )}
          {(mode === "login" || mode === "register" || mode === "forgot" || mode === "reset" || mode === "verify") && (
            <>
              <label htmlFor="omni-auth-email">Email address</label>
              <div className="omni-input-wrapper">
                <Mail size={19} />
                <input id="omni-auth-email" type="email" placeholder="you@company.com" autoComplete="email"
                  value={email} onChange={(event) => setEmail(event.target.value)} required disabled={mode === "verify" || mode === "reset"} />
              </div>
            </>
          )}

          {(mode === "login" || mode === "register" || mode === "reset") && (
            <>
              <label htmlFor="omni-auth-password">{mode === "reset" ? "New password" : "Password"}</label>
              <div className="omni-input-wrapper">
                <LockKeyhole size={19} />
                <input id="omni-auth-password" type={showPassword ? "text" : "password"}
                  placeholder={mode === "login" ? "Enter your password" : "Create a strong password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password} onChange={(event) => setPassword(event.target.value)} required />
                <button type="button" className="omni-password-toggle" onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}>
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
              {(mode === "register" || mode === "reset") && (
                <>
                  <p className="omni-password-rules">12+ characters with uppercase, lowercase, a number and a symbol.</p>
                  <label htmlFor="omni-auth-confirm">Confirm password</label>
                  <div className="omni-input-wrapper">
                    <LockKeyhole size={19} />
                    <input id="omni-auth-confirm" type="password" autoComplete="new-password"
                      value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
                  </div>
                </>
              )}
            </>
          )}

          {(mode === "verify" || mode === "reset") && (
            <>
              <label htmlFor="omni-auth-code">6-digit email code</label>
              <div className="omni-input-wrapper">
                <ShieldCheck size={19} />
                <input id="omni-auth-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
                  maxLength={6} placeholder="000000" value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required />
              </div>
            </>
          )}

          {message && <p className={`omni-auth-message ${messageType === "error" ? "error" : ""}`} role="status">{message}</p>}
          <button type="submit" className="omni-button omni-button-primary omni-login-submit" disabled={busy}>
            {busy ? "Please wait…" : ({ login: "Sign in", register: "Create account", verify: "Verify email", forgot: "Send reset code", reset: "Update password" }[mode])}
            {!busy && <ArrowRight size={18} />}
          </button>
          {mode === "login" && <p className="omni-login-security"><ShieldCheck size={17} /> Your account is protected with secure sign-in.</p>}
        </form>

        {mode === "login" && <div className="omni-auth-switch">
          <button className="omni-auth-link" type="button" onClick={() => changeMode("forgot")}>Forgot password?</button>
          <span>New to OmniCloud?</span>
          <button className="omni-auth-link" type="button" onClick={() => changeMode("register")}>Create an account</button>
        </div>}
        {mode === "register" && <div className="omni-auth-switch">
          <span>Already have an account?</span>
          <button className="omni-auth-link" type="button" onClick={() => changeMode("login")}>Sign in</button>
        </div>}
        {mode === "verify" && <div className="omni-auth-switch">
          <span>Didn’t receive the code?</span>
          <button className="omni-auth-link" type="button" onClick={resendVerification} disabled={busy}>Send another code</button>
          <button className="omni-auth-link" type="button" onClick={() => changeMode("login")}>Back to sign in</button>
        </div>}
        {(mode === "forgot" || mode === "reset") && <div className="omni-auth-switch">
          <button className="omni-auth-link" type="button" onClick={() => changeMode("login")}>Back to sign in</button>
        </div>}
      </section>
    </div>
  );
}
