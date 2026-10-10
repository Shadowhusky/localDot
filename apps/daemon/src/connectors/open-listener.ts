import { type KeydClient, KeydError, type OpenCellRequest } from "../keyd/client.ts";

// Older key services do not know the connector role. Desktop has the same web-only
// egress policy and still binds exactly the secrets supplied in this request.
export async function openConnectorListener(
  keyd: Pick<KeydClient, "openCell">,
  request: OpenCellRequest,
) {
  try {
    return await keyd.openCell(request);
  } catch (error) {
    if (
      !(error instanceof KeydError) ||
      error.status !== 400 ||
      !error.detail.includes('unknown role "connector"')
    )
      throw error;
    return keyd.openCell({ ...request, role: "desktop" });
  }
}
