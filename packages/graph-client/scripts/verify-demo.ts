import "dotenv/config"
import { closeDriver, runQuery } from "../src/client"
import {
  getNodeById,
  probeLabelCount,
  probeRelTypeCount,
  shortestPaths,
  traverseOneHop,
} from "../src/cypher"

async function main() {
  for (const label of [
    "Person",
    "Organization",
    "Project",
    "Channel",
    "Message",
    "Document",
    "Decision",
  ]) {
    const q = probeLabelCount(label)
    console.log(`label ${label}:`, await runQuery(q.query, q.params))
  }
  for (const relType of [
    "MEMBER_OF",
    "OWNS",
    "WORKS_ON",
    "AUTHORED",
    "DISCUSSED_IN",
    "REFERENCES",
    "SUPERSEDES",
    "CONTRADICTS",
    "PART_OF",
  ]) {
    const q = probeRelTypeCount(relType)
    console.log(`relType ${relType}:`, await runQuery(q.query, q.params))
  }

  const sam = getNodeById("Person", 1)
  console.log("Person 1:", await runQuery(sam.query, sam.params))

  const hop = traverseOneHop(1, "WORKS_ON", "outgoing")
  console.log("Sam WORKS_ON ->:", await runQuery(hop.query, hop.params))

  const paths = shortestPaths(1, 20, {
    relTypes: ["WORKS_ON", "DISCUSSED_IN"],
    relDirection: "outgoing",
    maxLen: 3,
    pathCount: 3,
  })
  console.log(
    "Sam -> #atlas-infra channel paths:",
    JSON.stringify(await runQuery(paths.query, paths.params), null, 2)
  )

  await closeDriver()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
