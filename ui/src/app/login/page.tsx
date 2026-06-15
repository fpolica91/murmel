import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <div className="center">
      <div className="panel">
        <h1>Sign in to aweb</h1>
        <p className="muted">
          Authenticate to get a team token. Single sign-on supported.
        </p>
        <LoginForm />
      </div>
    </div>
  );
}
