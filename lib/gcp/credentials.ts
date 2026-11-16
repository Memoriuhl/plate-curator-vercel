import { getToken } from '@vercel/connect'
import { AuthClient } from 'google-auth-library'

const CONNECTOR = 'firebase/plate-curator-vercel'

function connectToken(): Promise<string> {
  return getToken(CONNECTOR, { subject: { type: 'app' } })
}

class ConnectAuthClient extends AuthClient {
  async getAccessToken() {
    return { token: await connectToken() }
  }

  async getRequestHeaders() {
    return new Headers({ Authorization: `Bearer ${await connectToken()}` })
  }

  request: AuthClient['request'] = async (options) => {
    const headers = await this.getRequestHeaders()
    return this.transporter.request({ ...options, headers: new Headers([...new Headers(options.headers), ...headers]) })
  }
}

export function gcpAuthClient() {
  return new ConnectAuthClient()
}
