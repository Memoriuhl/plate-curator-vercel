import { SessionGate } from '../../components/app/session-gate'
import { SignInForm } from '../../components/sign-in-form'

export default function SignInPage() {
  return (
    <SessionGate signedIn={false}>
      <main className="sign-in-main">
        <SignInForm />
      </main>
    </SessionGate>
  )
}
