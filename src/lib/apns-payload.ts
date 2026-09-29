export interface LiveActivityPayloadArgs {
  event: "start" | "update";
  contentState: Record<string, unknown>;
  staleDate?: number;
  dismissalDate?: number;
  attributesType?: string;       // required by APNs for event:"start"
  attributes?: Record<string, unknown>;
}

/** Build the JSON string APNs expects for a Live Activity push. Pure + testable. */
export function buildLiveActivityPayload(args: LiveActivityPayloadArgs): string {
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: args.event,
    "content-state": args.contentState,
  };
  if (args.staleDate) aps["stale-date"] = args.staleDate;
  if (args.dismissalDate) aps["dismissal-date"] = args.dismissalDate;
  if (args.event === "start") {
    aps["attributes-type"] = args.attributesType;
    aps["attributes"] = args.attributes ?? {};
  }
  return JSON.stringify({ aps });
}
