import { FILE_LIMITS } from "./file-transfer.ts";
import type { useUploads } from "./useUploads.ts";
import "./files.css";
export function Attachments({
  uploads,
  disabled,
}: {
  uploads: ReturnType<typeof useUploads>;
  disabled: boolean;
}) {
  return (
    <section className="attachments" aria-label="Task attachments">
      <label className="file-picker">
        <span>Add files</span>
        <input
          type="file"
          multiple
          disabled={disabled}
          onChange={(event) => {
            const input = event.currentTarget;
            if (input.files) uploads.select(input.files);
            input.value = "";
          }}
        />
      </label>
      <p className="history-note">
        Up to {FILE_LIMITS.count} files, 100 MiB total. Only confirmed uploads are included when you
        send.
      </p>
      {!!uploads.rows.length && (
        <ul>
          {uploads.rows.map((row) => (
            <li key={row.id}>
              <span>
                {row.name} · {row.bytes.toLocaleString()} bytes
              </span>
              <span role="status">
                {row.phase === "complete"
                  ? "Uploaded to Downloads"
                  : row.phase === "uploading"
                    ? "Uploading…"
                    : row.phase === "pending"
                      ? "Waiting"
                      : row.phase === "uncertain"
                        ? "Upload unconfirmed"
                        : "Upload refused"}
              </span>
              {row.explanation && <p>{row.explanation}</p>}
              <button
                type="button"
                onClick={() => uploads.remove(row.id)}
                aria-label={`Remove ${row.name} from draft`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploads.problem && <p role="alert">{uploads.problem}</p>}
      {uploads.rows.some((row) => row.phase === "uploading" || row.phase === "pending") && (
        <button type="button" onClick={uploads.cancel}>
          Cancel uploads
        </button>
      )}
    </section>
  );
}
