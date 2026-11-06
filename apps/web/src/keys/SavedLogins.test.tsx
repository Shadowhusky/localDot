// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { KeysPanel } from "./KeysPanel.tsx";
import { SavedLogins } from "./SavedLogins.tsx";
import { importLogins, loginProblem, saveLogin } from "./saved-logins-api.ts";
import { useSavedLogins } from "./useSavedLogins.ts";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const SEAL_KEY =
  "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";

function fakeApi(over: { health?: Record<string, unknown>; list?: unknown[] } = {}) {
  const posts: { path: string; body: unknown }[] = [];
  const fetched: { url: string; init: RequestInit }[] = [];
  const api = {
    token: "t",
    authorization: () => "Bearer t",
    socketUrl: (path: string) => `ws://localhost${path}`,
    socketProtocols: () => [],
    get: vi.fn(async (path: string) =>
      path === "/api/keyd"
        ? { online: true, sealKey: SEAL_KEY, savedLogins: true, ...over.health }
        : { logins: over.list ?? [] },
    ),
    post: vi.fn(async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { login: { origin: "https://github.com", username: "octo", confirm: true } };
    }),
    put: vi.fn(),
    del: vi.fn(async () => {}),
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      fetched.push({ url, init });
      return new Response(
        JSON.stringify({
          rows: 3,
          imported: 2,
          alreadySaved: 1,
          skipped: [{ reason: "no-password", count: 1, lines: [4] }],
        }),
      );
    }),
  } as unknown as ApiClient;
  return { api, posts, fetched };
}

function view(over: Partial<Parameters<typeof SavedLogins>[0]["view"]> = {}) {
  return {
    logins: [
      { origin: "https://github.com", username: "octo@example.com", confirm: true },
      { origin: "https://www.amazon.com", username: "", confirm: true },
    ],
    loading: false,
    failure: null,
    busy: false,
    importing: false,
    summary: null,
    importProblem: null,
    save: vi.fn(async () => ({ origin: "https://github.com", username: "octo" })),
    remove: vi.fn(async () => {}),
    importFile: vi.fn(async () => {}),
    dismissSummary: vi.fn(),
    ...over,
  };
}

const PASSWORD = "plain-password-canary";

describe("the saved logins list", () => {
  it("shows site and account, and no way to read a password back", () => {
    const { container } = render(<SavedLogins view={view()} />);
    const list = screen.getByRole("list", { name: "Saved logins" });
    expect(within(list).getByText("octo@example.com")).toBeTruthy();
    expect(within(list).getByText("No account name")).toBeTruthy();
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(screen.queryByRole("button", { name: /show/i })).toBeNull();
  });

  it("removes only on the second tap", async () => {
    const v = view();
    render(<SavedLogins view={v} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove login for github.com" }));
    expect(v.remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm remove login for github.com" }));
    });
    expect(v.remove).toHaveBeenCalledExactlyOnceWith("https://github.com");
  });

  it("filters a long list", () => {
    const logins = Array.from({ length: 9 }, (_, i) => ({
      origin: `https://site${i}.example.com`,
      username: `account-${i}`,
    }));
    render(<SavedLogins view={view({ logins })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved logins" }), {
      target: { value: "account-3" },
    });
    const list = screen.getByRole("list", { name: "Saved logins" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });

  it("says why nothing can change while the keys are locked", () => {
    render(<SavedLogins view={view()} unavailable="Saved keys are locked until you unlock them" />);
    expect(screen.getByRole("button", { name: "Add login" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
});

describe("adding and editing a login", () => {
  it("saves a typed site as its HTTPS origin, then clears the password", async () => {
    const v = view();
    render(<SavedLogins view={v} />);
    fireEvent.click(screen.getByRole("button", { name: "Add login" }));
    const form = screen.getByRole("form", { name: "Add a login" });
    const site = within(form).getByRole("textbox", { name: "Site" });
    fireEvent.change(site, { target: { value: "https://GitHub.com/login" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Account" }), {
      target: { value: " octo " },
    });
    const password = within(form).getByRole("textbox", { name: "Password" }) as HTMLInputElement;
    fireEvent.change(password, { target: { value: PASSWORD } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(v.save).toHaveBeenCalledExactlyOnceWith({
      origin: "https://github.com",
      username: "octo",
      password: PASSWORD,
    });
    expect(password.value).toBe("");
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(screen.getByRole("status").textContent).toContain("github.com");
  });

  it("refuses a local or empty site and a missing password, in words", async () => {
    const v = view();
    render(<SavedLogins view={v} />);
    fireEvent.click(screen.getByRole("button", { name: "Add login" }));
    const form = screen.getByRole("form", { name: "Add a login" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Site" }), {
      target: { value: "localhost" },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(v.save).not.toHaveBeenCalled();
    expect(within(form).getByText("Enter a public site, like github.com.")).toBeTruthy();
    expect(within(form).getByText("Enter the password.")).toBeTruthy();
  });

  it("edits the account alone, keeping the site and the saved password", async () => {
    const v = view();
    render(<SavedLogins view={v} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit login for github.com" }));
    const form = screen.getByRole("form", { name: "Edit login for github.com" });
    const site = within(form).getByRole("textbox", { name: "Site" }) as HTMLInputElement;
    expect(site.readOnly).toBe(true);
    const password = within(form).getByRole("textbox", {
      name: "New password",
    }) as HTMLInputElement;
    expect(password.value).toBe("");
    fireEvent.change(within(form).getByRole("textbox", { name: "Account" }), {
      target: { value: "renamed" },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(v.save).toHaveBeenCalledExactlyOnceWith({
      origin: "https://github.com",
      username: "renamed",
    });
  });
});

describe("importing an export", () => {
  it("says before and after that the file should be deleted, in counts and lines only", () => {
    const { rerender } = render(<SavedLogins view={view()} />);
    expect(screen.getByText(/delete it afterwards/)).toBeTruthy();
    rerender(
      <SavedLogins
        view={view({
          summary: {
            rows: 40,
            imported: 30,
            alreadySaved: 2,
            skipped: [
              { reason: "no-password", count: 3, lines: [4, 8, 12] },
              {
                reason: "not-https",
                count: 25,
                lines: Array.from({ length: 20 }, (_, i) => i + 2),
              },
            ],
          },
        })}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Imported 30 logins.");
    expect(status.textContent).toContain("2 sites have a saved login already");
    expect(status.textContent).toContain("3 rows left out: no password (lines 4, 8, 12)");
    expect(status.textContent).toContain("and more");
    expect(status.textContent).toContain("Delete the file now");
  });

  it("clears the file input as soon as a file is chosen", async () => {
    const v = view();
    const { container } = render(<SavedLogins view={v} />);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File(["name,url,username,password\n"], "passwords.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      fireEvent.change(input);
    });
    expect(v.importFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(input.value).toBe("");
  });

  it("sends only ciphertext, through a wait long enough, and wipes the bytes", async () => {
    const f = fakeApi();
    const bytes = new TextEncoder().encode(
      `name,url,username,password\nA,https://a.test,b,${PASSWORD}\n`,
    );
    const fill = vi.spyOn(Uint8Array.prototype, "fill");
    const file = new File([bytes], "passwords.csv");
    const summary = await importLogins(f.api, file);
    expect(summary).toMatchObject({ imported: 2, alreadySaved: 1 });
    expect(f.fetched).toHaveLength(1);
    const [call] = f.fetched;
    expect(call?.url).toBe("http://localhost/api/logins/import");
    const body = String(call?.init.body);
    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain("https://a.test");
    expect(body).not.toContain("passwords.csv");
    expect(Object.keys(JSON.parse(body))).toEqual(["sealed"]);
    expect(fill).toHaveBeenCalledWith(0);
  });

  it("refuses a file too big to be an export before reading it", async () => {
    const f = fakeApi();
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.csv");
    const read = vi.spyOn(big, "arrayBuffer");
    await expect(importLogins(f.api, big)).rejects.toThrow(/too big/);
    expect(read).not.toHaveBeenCalled();
    expect(f.fetched).toHaveLength(0);
  });

  it("tells an older key service apart, with nothing sent", async () => {
    const f = fakeApi({ health: { savedLogins: false } });
    await expect(importLogins(f.api, new File(["x"], "a.csv"))).rejects.toThrow(/Update localDot/);
    expect(f.fetched).toHaveLength(0);
  });

  it("seals again once when keyd restarted under the file", async () => {
    const f = fakeApi();
    vi.mocked(f.api.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "bad-seal", message: "seal again" }), { status: 409 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rows: 0, imported: 0, alreadySaved: 0, skipped: [] })),
      );
    await importLogins(f.api, new File(["url,password\n"], "a.csv"));
    expect(f.api.fetch).toHaveBeenCalledTimes(2);
  });

  it("explains a lost answer and a refused file without quoting anything", () => {
    expect(
      loginProblem(
        new ApiError(400, JSON.stringify({ error: "not-an-export", message: "x" })),
        "other",
      ),
    ).toContain("doesn't look like a password export");
    expect(loginProblem(new ApiError(413, "too big"), "other")).toContain("too big");
    expect(
      loginProblem(new ApiError(423, JSON.stringify({ error: "vault-locked" })), "other"),
    ).toContain("locked");
  });
});

describe("saving a login", () => {
  it("posts only ciphertext, with the site inside it", async () => {
    const f = fakeApi();
    await saveLogin(f.api, { origin: "https://github.com", username: "octo", password: PASSWORD });
    const [call] = f.posts;
    expect(call?.path).toBe("/api/logins");
    const body = JSON.stringify(call?.body);
    for (const value of [PASSWORD, "octo", "github.com"]) expect(body).not.toContain(value);
    expect(Object.keys(call?.body as object)).toEqual(["sealed"]);
  });
});

describe("useSavedLogins in Keys", () => {
  function Panel({ api }: { api: ApiClient }) {
    const logins = useSavedLogins(api, true, "boot");
    return (
      <KeysPanel
        active
        logins={logins}
        keys={{
          health: { online: true, sealKey: SEAL_KEY, savedLogins: true },
          keys: [],
          loadError: null,
          busy: false,
          save: vi.fn(),
          remove: vi.fn(),
        }}
      />
    );
  }
  it("lists the logins beside the keys, and an empty list says how to start", async () => {
    render(<Panel api={fakeApi().api} />);
    await screen.findByText("No saved logins yet");
    cleanup();
    render(
      <Panel api={fakeApi({ list: [{ origin: "https://github.com", username: "octo" }] }).api} />,
    );
    await screen.findByText("octo");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Saved logins" })).toBeTruthy());
  });
});
