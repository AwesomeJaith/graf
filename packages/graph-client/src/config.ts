export interface HydraDbConfig {
  boltUri: string
  httpUri?: string
  authToken?: string
  username?: string
  password?: string
  /** Bolt `database` name, only needed for a multi-namespace/graph HydraDB deployment. */
  database?: string
  namespace?: string
  graphId?: string
  cellId?: string
}

/**
 * Reads HydraDB connection config from the environment. A single `.env`
 * switch (HYDRADB_BOLT_URL + auth) is all that's needed to point Graf at a
 * different HydraDB instance/graph.
 */
export function loadHydraDbConfig(
  env: NodeJS.ProcessEnv = process.env
): HydraDbConfig {
  const boltUri = env.HYDRADB_BOLT_URL
  if (!boltUri) {
    throw new Error(
      "HYDRADB_BOLT_URL is not set. Point it at a routed neo4j:// (or neo4j+s:///neo4j+ssc://) URI for your HydraDB instance."
    )
  }
  return {
    boltUri,
    httpUri: env.HYDRADB_HTTP_URL,
    authToken: env.HYDRADB_AUTH_TOKEN,
    username: env.HYDRADB_USERNAME,
    password: env.HYDRADB_PASSWORD,
    database: env.HYDRADB_DATABASE,
    namespace: env.HYDRADB_NAMESPACE,
    graphId: env.HYDRADB_GRAPH_ID,
    cellId: env.HYDRADB_CELL_ID,
  }
}
