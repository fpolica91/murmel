export const meta = {
  name: 'adversarial-infiltration',
  description: 'Autonomous red-team agents try to infiltrate team default:local from outside — spoof membership, exfil by id, inject, cross-team message, MCP — and report any breach',
  phases: [
    { title: 'Attack', detail: '5 adversary agents, one vector each' },
    { title: 'Judge', detail: 'any breach == fail' },
  ],
}

const ATTACK_OUT = {
  type: 'object', additionalProperties: false,
  required: ['vector', 'attempts', 'infiltrated', 'evidence'],
  properties: {
    vector: { type: 'string' },
    attempts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['action', 'result'], properties: { action: { type: 'string' }, result: { type: 'string' } } } },
    infiltrated: { type: 'boolean', description: 'true if ANY attempt returned another team data or landed a write in it' },
    evidence: { type: 'string' },
  },
}

const JUDGE_OUT = {
  type: 'object', additionalProperties: false,
  required: ['any_breach', 'breached_vectors', 'verdict', 'summary'],
  properties: {
    any_breach: { type: 'boolean' },
    breached_vectors: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['sealed', 'breached'] },
    summary: { type: 'string' },
  },
}

// Real default:local targets the attacker has somehow learned the IDs of.
const T = {
  session: '38c9c34c-39f6-4e60-badf-b8a28e432709',
  issue: 'b8d28187-a2e9-4a0f-b55e-f22061082e56',
  conv: '4af31cde-6cd3-4c8a-af9d-ef235ebe80cb',
  victimTeam: 'default:local',
  attackerTeam: '66ce2a0cc4:personal',
}

const MINT = `Mint the attacker token first:
  curl -s -c /tmp/adv.txt http://localhost:3030/api/auth/sign-in/email -H 'content-type: application/json' -d '{"email":"mallory@local.test","password":"Test1234!pass"}' -o /dev/null
  TOK=$(curl -s -b /tmp/adv.txt http://localhost:3030/api/auth/token | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
You are Mallory, a member of ONLY team ${T.attackerTeam} — you are NOT a member of ${T.victimTeam}. AWEB base = http://localhost:8088. Use -w ' [HTTP %{http_code}]' on curls to capture status. A 200 returning ${T.victimTeam} content = INFILTRATION. A 401/403/404/empty = blocked. Report every attempt honestly.`

const VECTORS = [
  { key: 'membership-spoof-read', desc: `${MINT}\nVECTOR: spoof membership by sending header "x-aweb-team-id: ${T.victimTeam}" with your token on READ endpoints. Try GET /v1/issues, GET /v1/contacts, GET /v1/work/ready (or /v1/issues?status=todo), GET /v1/teams/${T.victimTeam}/members. infiltrated=true only if any returns ${T.victimTeam} data with 2xx.` },
  { key: 'membership-spoof-write', desc: `${MINT}\nVECTOR: spoof membership to INJECT into ${T.victimTeam}. With header "x-aweb-team-id: ${T.victimTeam}": POST /v1/issues {"title":"pwned-by-mallory"}; POST a chat/mail to an agent. infiltrated=true if any write lands (verify by trying to read it back, e.g. an issue id returned).` },
  { key: 'direct-object-exfil', desc: `${MINT}\nVECTOR: direct object reference — from YOUR OWN team (header "x-aweb-team-id: ${T.attackerTeam}") AND also with the victim header, GET the specific victim resources by id: /v1/chat/sessions/${T.session}/messages ; /v1/issues/${T.issue} ; /v1/conversations/${T.conv} (or the mail conversation endpoint). infiltrated=true if any returns the victim's content.` },
  { key: 'cross-team-message', desc: `${MINT}\nVECTOR: deliver a message across the boundary. Install/use the aw CLI: bind a workspace to YOUR team ( mkdir -p /tmp/adv-ws && cd /tmp/adv-ws && AWEB_URL=http://localhost:8088 AW_TOKEN=$TOK aw init --team ${T.attackerTeam} --do-not-touch-agents-md ). Then try to send chat/mail to a ${T.victimTeam} agent by alias/address, e.g. AWEB_URL=http://localhost:8088 AW_TOKEN=$TOK aw mail send --to "local/Ada (agent)" --body "hi" and aw chat send-and-leave "local/Ada (agent)" "hi". infiltrated=true if a message is actually delivered into ${T.victimTeam} (not bounced/denied).` },
  { key: 'mcp-tool-infiltration', desc: `${MINT}\nVECTOR: hit the MCP endpoint directly. POST http://localhost:8088/mcp/ with "Authorization: Bearer $TOK", "x-aweb-team-id: ${T.victimTeam}", Accept: application/json, text/event-stream, and a JSON-RPC body. First initialize, then call tools/list and a read tool (e.g. read_chat / chat_history with session ${T.session}, or check_inbox, or issues_list). If the MCP handshake is hard over curl, document what you tried and the responses. infiltrated=true only if MCP returns ${T.victimTeam} data.` },
]

phase('Attack')
const results = await parallel(
  VECTORS.map((v) => () => agent(v.desc, { label: `attack:${v.key}`, phase: 'Attack', schema: ATTACK_OUT, effort: 'high' }))
)

phase('Judge')
const judge = await agent(
  `You are the security judge. Below are 5 red-team reports attacking team ${T.victimTeam} from outside. Determine if ANY achieved real infiltration (read another team's data, or landed a write/message into it). Be skeptical: a 401/403/404, an empty list, a bounce, or "session not found" is NOT a breach. Only a 2xx returning victim content, or a confirmed delivered message/created object in the victim team, counts.\n\nREPORTS:\n${JSON.stringify(results, null, 2)}`,
  { label: 'judge', phase: 'Judge', schema: JUDGE_OUT, effort: 'high' }
)

return { vectors: results.map((r) => r && { vector: r.vector, infiltrated: r.infiltrated }), judge }
