import "dotenv/config"
import { closeDriver, runWrites } from "@workspace/graph-client"

async function main() {
  const labels = ["Person", "Organization", "Project", "Channel", "Document", "Message", "Task", "Issue"]
  await runWrites(labels.map((label) => ({ query: `MATCH (n:${label}) WHERE n.id >= 10000 DETACH DELETE n` })))
  console.log("Cleared existing bench-ingested nodes/relationships (id >= 10000).")
  await closeDriver()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
