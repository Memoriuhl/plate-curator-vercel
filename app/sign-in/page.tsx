import { SessionGate } from '../../components/app/session-gate'
import { SignInForm } from '../../components/app/sign-in-form'

/**
 * Render the sign-in form and let the session gate route signed-in users to the
 * workspace.
 */
export default function SignInPage() {
  return (
    <SessionGate signedIn={false}>
      <main className="sign-in-main">
        <SignInForm />
      </main>
    </SessionGate>
  )
}
