import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveControlledOwnerDatabaseUserId } from '../server/audit/repository'
import { createColabLocalSnapshot, toColabJsonl } from '../server/public-intelligence/colab-local'

const outputDir = resolve(process.argv[2] || '/home/ubuntu/private-training-output')
const ownerOpenId = process.env.NUXT_OWNER_OPEN_ID || process.env.OWNER_OPEN_ID
const ownerUserId = await resolveControlledOwnerDatabaseUserId(ownerOpenId)
const prepared = await createColabLocalSnapshot({ ownerUserId, datasetBuildId: 1 })
await mkdir(outputDir, { recursive: true, mode: 0o700 })
const destination = resolve(outputDir, `discoverystack-manifest-1-${prepared.dataset.manifestHash.slice(0, 12)}.jsonl`)
await writeFile(destination, toColabJsonl(prepared.snapshot), { mode: 0o600 })
await chmod(destination, 0o600)
console.log(JSON.stringify({ datasetBuildId: prepared.dataset.id, manifestHash: prepared.dataset.manifestHash, datasetDigest: prepared.datasetDigest, rowCount: prepared.snapshot.length, output: destination }))
