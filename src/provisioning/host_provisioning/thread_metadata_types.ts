export interface ThreadMcpHeaderConfig {
  key: string;
  value: string;
}

export interface ThreadMcpServerConfig {
  name: string;
  transport: "stdio" | "streamable_http";
  command?: string;
  args: string[];
  envVars: ThreadMcpHeaderConfig[];
  url?: string;
  authType: "none" | "bearer_token";
  bearerToken?: string | null;
  headers: ThreadMcpHeaderConfig[];
}
