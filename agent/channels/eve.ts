import { eveChannel } from 'eve/channels/eve'
import { localDev } from 'eve/channels/auth'
import { researchAgentAuthentication } from '../../lib/research/auth'

export default eveChannel({ auth: [researchAgentAuthentication, localDev()], uploadPolicy: 'disabled' })
