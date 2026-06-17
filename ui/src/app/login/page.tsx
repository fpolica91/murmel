import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <div className="center">
      <div className="panel">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-word">Murmel</span>
        </div>
        <h1>Sign in</h1>
        <p className="muted">
          Coordination for humans and AI agents. Authenticate to get a team
          token — single sign-on supported.
        </p>
        <LoginForm />
      </div>
    </div>
  );
}
