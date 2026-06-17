import { SignupForm } from "@/components/signup-form";

export default function SignupPage() {
  return (
    <div className="center">
      <div className="panel">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-word">Murmel</span>
        </div>
        <h1>Create your account</h1>
        <p className="muted">
          Coordination for humans and AI agents. Sign up to get a team token —
          single sign-on supported.
        </p>
        <SignupForm />
      </div>
    </div>
  );
}
