import {
  CONVERSATION_TAGS,
  ConversationList,
  type ConversationTag,
  PERSONAS,
  type PersonaId,
} from "@localdot/protocol";
import { useMemo, useRef } from "react";
import {
  conversationStatus,
  conversationTitle,
  type LiveFacts,
  type Organize,
  organizeConversation,
  STATUS_LABEL,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import { researchQuestion } from "../agent/research.ts";
import type { ApiClient } from "../lib/api.ts";
import { APPEARANCE_NAMES } from "../onboarding/AppearancePicker.tsx";
import { APPEARANCE_CHOICES, type AppearanceChoice } from "../onboarding/appearance.ts";
import { addEntry, MemoryRequestError } from "../settings/memory/memory-api.ts";
import type { ModelGroup, ModelOption } from "../settings/model-options.ts";
import { SECTIONS, type SettingsSection } from "../settings/sections.ts";
import { announce } from "../ui/Announcer.tsx";
import { TAG_NAMES } from "../ui/ConversationTag.tsx";
import { showToast } from "../ui/Toast.tsx";
import { type Action, type ActionChoice, fillComposer } from "./actions.ts";
import type { AsideControl } from "./useAside.ts";

// An action the app can take now, or why not.
export interface Doable {
  readonly reason?: string;
  run(): void;
}

export interface ActionsInput {
  readonly api: ApiClient;
  readonly phone: boolean;
  readonly sessionId: string | null;
  readonly stop: Doable;
  readonly continue: Doable;
  readonly take: Doable;
  readonly handBack: Doable;
  // Why research can't start now.
  readonly research?: string;
  readonly aside: AsideControl;
  readonly newConversation: Doable;
  readonly conversations: {
    readonly reason?: string;
    // The current conversation's latest task, which names it.
    readonly current: string | null;
    readonly facts: LiveFacts;
    pick(id: string, sessions: readonly string[]): void;
    renamed(): void;
    // Asks before deleting the current conversation.
    remove(trigger: HTMLElement | null): void;
  };
  readonly replay: Doable;
  readonly watch: Doable;
  readonly models: {
    readonly groups: readonly ModelGroup[];
    readonly current?: string;
    readonly reason?: string;
    choose(option: ModelOption): void;
  };
  readonly persona: { readonly value: PersonaId; choose(id: PersonaId): void };
  // A subscription plan is in use, so there is usage to show.
  readonly plans: boolean;
  refreshUsage(): void;
  report(trigger: HTMLElement | null, title?: string): void;
  view(view: "chat" | "activity" | "routines"): void;
  readonly files: Doable;
  readonly previews: Doable;
  // Hides or shows the conversation beside the computer, on a wide screen.
  readonly chatPanel?: { readonly shown: boolean; toggle(): void };
  readonly fullScreen: Doable & { readonly on: boolean };
  settings(trigger: HTMLElement | null, section?: SettingsSection): void;
  readonly appearance: {
    readonly value: AppearanceChoice;
    change(value: AppearanceChoice): void;
  };
  readonly otherDots: readonly { readonly id: string; readonly name: string; open(): void }[];
  readonly stopAll: Doable;
  newRoutine(trigger: HTMLElement | null): void;
  shortcuts(): void;
}

const APPEARANCES = APPEARANCE_CHOICES.map((value) => ({ value, label: APPEARANCE_NAMES[value] }));
const RENAME_MAX = 80;
const MEMORY_PROBLEMS: Partial<Record<string, string>> = {
  invalid: "dot can't keep that. Keep it under 1,000 characters, with no keys in it.",
  busy: "Memory can't change right now. Try again in a moment.",
  full: "Memory is full. Remove something in Settings → What dot knows first.",
};

// Every action the slash commands and the palette offer, as the app stands. Only what an action
// shows (whether it can run, its choices) redraws its users; what running it does is read when it
// runs, from the latest render.
export function useActions(input: ActionsInput): {
  actions: readonly Action[];
  suggested: string[];
} {
  const latest = useRef(input);
  latest.current = input;
  const now = () => latest.current;
  const {
    api,
    phone,
    sessionId,
    research,
    plans,
    otherDots,
    chatPanel,
    persona,
    appearance,
    conversations,
  } = input;
  const stopReason = input.stop.reason;
  const continueReason = input.continue.reason;
  const takeReason = input.take.reason;
  const handBackReason = input.handBack.reason;
  const newReason = input.newConversation.reason;
  const replayReason = input.replay.reason;
  const watchReason = input.watch.reason;
  const filesReason = input.files.reason;
  const previewsReason = input.previews.reason;
  const fullReason = input.fullScreen.reason;
  const fullOn = input.fullScreen.on;
  const stopAllReason = input.stopAll.reason;
  const chatShown = chatPanel?.shown;
  const hasChatPanel = !!chatPanel;
  const modelGroups = input.models.groups;
  const modelCurrent = input.models.current;
  const modelReason = input.models.reason;
  // The tasks of each conversation listed, to view one while the user has the computer.
  const listed = useRef(new Map<string, readonly string[]>());
  const conversationReason = conversations.reason;
  const currentConversation = conversations.current;
  const facts = conversations.facts;
  // How the current conversation is kept, as the lists last read it.
  const recent = useRecentConversations(api, false).entries;
  const archived = useRecentConversations(api, false, "archived").entries;
  const filed = [...recent, ...archived].find((entry) =>
    entry.sessions.includes(currentConversation ?? ""),
  );
  const filedTag = filed?.tag;
  const filedPinned = !!filed?.pinned;
  const filedArchived = !!filed?.archived;
  const underWay =
    !!filed?.live ||
    (!!facts.live && (filed?.sessions ?? [currentConversation]).includes(facts.live));
  // biome-ignore lint/correctness/useExhaustiveDependencies: what runs is read from the latest render; these are what the actions show
  const actions = useMemo((): Action[] => {
    const doable = (pick: (input: ActionsInput) => Doable) => () => {
      if (!pick(now()).reason) pick(now()).run();
    };
    const noConversation = currentConversation ? undefined : "Start a conversation first";
    const organize = async (change: Organize, done: string) => {
      const id = now().conversations.current;
      if (!id) return "Start a conversation first.";
      try {
        await organizeConversation(api, id, change);
      } catch {
        return "That change couldn't be saved. Try again.";
      }
      announce("conversation", done);
      return undefined;
    };
    const modelChoices: ActionChoice[] = modelGroups.flatMap((group) =>
      group.options.map((option) => ({
        value: option.id,
        label: option.name,
        detail: group.label,
        current: option.id === modelCurrent,
      })),
    );
    return [
      {
        id: "btw",
        command: "btw",
        title: "Ask a side question",
        description: "Ask about this task without interrupting it. dot never sees it.",
        hint: "<question>",
        group: "Task",
        icon: "message-circle",
        keywords: "by the way aside side question quick",
        input: "required",
        placeholder: "Ask about this task…",
        unavailable: sessionId ? undefined : "Start a task first",
        run: ({ text }) => now().aside.ask(text),
      },
      {
        id: "stop",
        command: "stop",
        title: "Stop the task",
        description: "Stop dot's current task",
        group: "Task",
        icon: "stop",
        keywords: "cancel halt pause end",
        keys: ["Mod", "Shift", "."],
        unavailable: stopReason,
        run: doable((i) => i.stop),
      },
      {
        id: "continue",
        command: "continue",
        title: "Continue the task",
        description: "Carry on a paused or interrupted task",
        group: "Task",
        icon: "continue",
        keywords: "resume unpause carry on",
        unavailable: continueReason,
        run: doable((i) => i.continue),
      },
      {
        id: "takeover",
        command: "takeover",
        title: "Take control",
        description: "Use the computer yourself while dot waits",
        group: "Task",
        icon: "hand",
        keywords: "take over control computer myself",
        unavailable: takeReason,
        run: doable((i) => i.take),
      },
      {
        id: "handback",
        command: "handback",
        title: "Hand back",
        description: "Give the computer back to dot",
        group: "Task",
        icon: "hand-back",
        keywords: "give back return control",
        unavailable: handBackReason,
        run: doable((i) => i.handBack),
      },
      {
        id: "new",
        command: "new",
        title: "New conversation",
        description: "Start afresh; this conversation stays in the list",
        group: "Conversation",
        icon: "compose",
        keywords: "clear fresh start",
        unavailable: newReason,
        run: doable((i) => i.newConversation),
      },
      {
        id: "resume",
        command: "resume",
        title: "Switch conversation",
        description: "Pick up an earlier conversation where it left off",
        hint: "[search]",
        group: "Conversation",
        icon: "message-circle",
        keywords: "open continue history conversations chats earlier",
        placeholder: "Search conversations",
        unavailable: conversationReason,
        searchable: true,
        choices: async (signal) => {
          const { conversations } = ConversationList.parse(
            await api.get("/api/conversations", { signal }),
          );
          const today = new Date();
          listed.current = new Map(conversations.map((entry) => [entry.sessionId, entry.sessions]));
          return conversations.map((entry) => ({
            value: entry.sessionId,
            label: conversationTitle(entry),
            detail: `${STATUS_LABEL[conversationStatus(entry, facts)]} · ${whenLabel(entry.startedAt, today)}`,
            keywords: entry.said ?? undefined,
            current: entry.sessionId === currentConversation,
          }));
        },
        run: ({ choice }) => {
          if (choice)
            now().conversations.pick(
              choice.value,
              listed.current.get(choice.value) ?? [choice.value],
            );
        },
      },
      {
        id: "rename",
        command: "rename",
        title: "Rename this conversation",
        description: "Give it a name of your own, or let dot name it again",
        hint: "[name]",
        group: "Conversation",
        icon: "file-text",
        keywords: "title name",
        input: "optional",
        placeholder: "A name for this conversation",
        unavailable: currentConversation ? undefined : "Start a conversation first",
        choices: [{ value: "auto", label: "Use the automatic title", detail: "dot names it" }],
        run: async ({ text, choice }) => {
          const id = now().conversations.current;
          if (!id) return "Start a conversation first.";
          const title = choice?.value === "auto" ? null : text.trim();
          if (title !== null && (!title || title.length > RENAME_MAX))
            return `Use a name of 1–${RENAME_MAX} characters.`;
          try {
            await api.post(`/api/conversations/${id}/title`, { title });
          } catch {
            return "Couldn't rename the conversation. Try again.";
          }
          now().conversations.renamed();
          announce("conversation", title ? `Renamed to ${title}.` : "dot names this conversation.");
          return undefined;
        },
      },
      {
        id: "tag",
        command: "tag",
        title: "Tag this conversation",
        description: "Give it a colour to tell it apart in the list",
        hint: "[colour]",
        group: "Conversation",
        icon: "tag",
        keywords: "colour color label mark",
        placeholder: "Search colours",
        unavailable: noConversation,
        choices: [
          { value: "none", label: "No tag", current: !filedTag },
          ...CONVERSATION_TAGS.map((tag) => ({
            value: tag,
            label: TAG_NAMES[tag],
            current: tag === filedTag,
          })),
        ],
        run: ({ choice }) => {
          if (!choice) return undefined;
          const tag = choice.value === "none" ? null : (choice.value as ConversationTag);
          return organize(
            { tag },
            tag ? `Tagged ${TAG_NAMES[tag].toLowerCase()}.` : "Tag taken off.",
          );
        },
      },
      {
        id: "pin",
        command: "pin",
        title: filedPinned ? "Unpin this conversation" : "Pin this conversation",
        description: filedPinned
          ? "Let it move down the list with the rest"
          : "Keep it at the top of the list",
        group: "Conversation",
        icon: "pin",
        keywords: "top favourite favorite star keep",
        unavailable: noConversation,
        run: () =>
          organize(
            { pinned: !filedPinned },
            filedPinned ? "Unpinned this conversation." : "Pinned to the top.",
          ),
      },
      {
        id: "archive",
        command: "archive",
        title: filedArchived ? "Unarchive this conversation" : "Archive this conversation",
        description: filedArchived
          ? "Bring it back to the list"
          : "Put it away; it comes back if it goes on",
        group: "Conversation",
        icon: filedArchived ? "archive-restore" : "archive",
        keywords: "hide put away tidy",
        unavailable:
          noConversation ??
          (underWay && !filedArchived
            ? "Stop the task before archiving its conversation"
            : undefined),
        run: () =>
          organize(
            { archived: !filedArchived },
            filedArchived ? "Back in the list." : "Archived. It's under Archived in the list.",
          ),
      },
      {
        id: "delete-conversation",
        title: "Delete this conversation",
        description: "Its messages, recordings and screenshots, for good",
        group: "Conversation",
        icon: "trash",
        keywords: "remove erase forget",
        unavailable:
          noConversation ??
          (underWay ? "Stop the task before deleting its conversation" : undefined),
        run: ({ trigger }) => now().conversations.remove(trigger),
      },
      {
        id: "replay",
        command: "replay",
        title: "Open Replay",
        description: "Watch this task back, or browse your recordings",
        group: "Conversation",
        icon: "history",
        keywords: "recording video watch back history",
        unavailable: replayReason,
        run: doable((i) => i.replay),
      },
      {
        id: "research",
        command: "research",
        title: "Research a question",
        description: "dot reads many sources and writes a cited report",
        hint: "<question>",
        group: "Task",
        icon: "globe",
        keywords: "search web report sources",
        input: "required",
        placeholder: "What should dot research?",
        unavailable: research,
        run: ({ text }) => researchQuestion(text),
      },
      {
        id: "model",
        command: "model",
        title: "Switch model",
        description: "Choose the model dot works with",
        hint: "[name]",
        group: "dot",
        icon: "cpu",
        keywords: "llm provider claude gpt",
        placeholder: "Search models",
        unavailable: modelReason,
        searchable: true,
        choices: modelChoices,
        run: ({ choice }) => {
          const option = now()
            .models.groups.flatMap((group) => group.options)
            .find((each) => each.id === choice?.value);
          if (option) now().models.choose(option);
        },
      },
      {
        id: "dot",
        command: "dot",
        title: "Switch dot",
        description: "Choose which dot works with you, from the next task",
        hint: "[name]",
        group: "dot",
        icon: "smile",
        keywords: "persona character",
        placeholder: "Search dots",
        searchable: true,
        choices: Object.values(PERSONAS).map((each) => ({
          value: each.id,
          label: each.name,
          detail: each.blurb,
          current: each.id === persona.value,
        })),
        run: ({ choice }) => {
          const chosen = Object.values(PERSONAS).find((each) => each.id === choice?.value);
          if (!chosen) return;
          now().persona.choose(chosen.id);
          announce("persona", `${chosen.name} works with you from the next task.`);
        },
      },
      {
        id: "remember",
        command: "remember",
        title: "Remember something",
        description: "Save a fact dot keeps for every task",
        hint: "<fact>",
        group: "dot",
        icon: "book",
        keywords: "memory note fact know",
        input: "required",
        placeholder: "What should dot remember?",
        run: async ({ text }) => {
          try {
            await addEntry(api, "MEMORY.md", text);
          } catch (error) {
            return (
              (error instanceof MemoryRequestError && MEMORY_PROBLEMS[error.reason]) ||
              "Couldn't save that. Try again."
            );
          }
          showToast({
            title: "dot will remember that",
            action: { label: "View", onAction: () => now().settings(null, "knowledge") },
          });
          return undefined;
        },
      },
      {
        id: "usage",
        command: "usage",
        title: "Show plan usage",
        description: "How much of your ChatGPT or Claude plan is used",
        group: "dot",
        icon: "chart",
        keywords: "limits quota plan subscription spending",
        run: () => {
          if (now().plans) now().refreshUsage();
          now().aside.showUsage();
        },
      },
      {
        id: "report",
        command: "report",
        title: "Report a problem",
        description: "Tell the localDot team what went wrong",
        hint: "[what happened]",
        group: "Help",
        icon: "circle-alert",
        keywords: "bug feedback issue",
        input: "optional",
        run: ({ text, trigger }) => now().report(trigger, text || undefined),
      },
      {
        id: "help",
        command: "help",
        title: "Show commands",
        description: "List every command you can type after /",
        group: "Help",
        icon: "info",
        keywords: "commands slash list",
        run: () => fillComposer("/"),
      },
      {
        id: "shortcuts",
        command: "shortcuts",
        title: "Keyboard shortcuts",
        description: "Every key that does something here",
        group: "Help",
        icon: "keyboard",
        keywords: "keys hotkeys",
        keys: ["?"],
        run: () => now().shortcuts(),
      },
      {
        id: "watch",
        title: "Go to Watch",
        description: "The live computer and this conversation",
        group: "Go to",
        icon: "monitor",
        keywords: "live leave replay",
        unavailable: watchReason,
        run: doable((i) => i.watch),
      },
      {
        id: "view-chat",
        title: "Show the chat",
        description: "This conversation",
        group: "Go to",
        icon: "message-circle",
        keywords: "thread messages tab",
        run: () => now().view("chat"),
      },
      {
        id: "view-activity",
        title: "Show Activity",
        description: "Steps, files and sources of this task",
        group: "Go to",
        icon: "list",
        keywords: "steps timeline tab",
        run: () => now().view("activity"),
      },
      {
        id: "files",
        title: "Show files",
        description: "Files dot made or changed in this task",
        group: "Go to",
        icon: "file",
        keywords: "downloads results outputs activity",
        unavailable: filesReason,
        run: doable((i) => i.files),
      },
      {
        id: "previews",
        title: "Show previews",
        description: "Apps dot started on its computer",
        group: "Go to",
        icon: "app-window",
        keywords: "dev server preview localhost activity",
        unavailable: previewsReason,
        run: doable((i) => i.previews),
      },
      {
        id: "view-routines",
        title: "Show Routines",
        description: "Tasks dot runs on a schedule",
        group: "Go to",
        icon: "repeat",
        keywords: "schedule tab",
        run: () => now().view("routines"),
      },
      ...(hasChatPanel
        ? [
            {
              id: "chat-panel",
              title: chatShown ? "Hide the conversation panel" : "Show the conversation panel",
              description: "Give the computer the whole width, or bring the chat back",
              group: "Go to",
              icon: "panel-right",
              keywords: "toggle sidebar rail chat",
              run: () => now().chatPanel?.toggle(),
            } satisfies Action,
          ]
        : []),
      {
        id: "full-screen",
        title: fullOn ? "Leave full screen" : "Full screen",
        description: "The computer's screen on its own",
        group: "Go to",
        icon: fullOn ? "shrink" : "expand",
        keywords: "fullscreen focus",
        keys: phone ? undefined : ["Mod", "Shift", "F"],
        unavailable: fullReason,
        run: doable((i) => i.fullScreen),
      },
      {
        id: "settings",
        title: "Open Settings",
        description: "Models, autonomy, keys and more",
        group: "Settings",
        icon: "settings",
        keywords: "preferences options",
        run: ({ trigger }) => now().settings(trigger),
      },
      {
        id: "settings-section",
        title: "Settings section",
        description: "Go straight to one part of Settings",
        group: "Settings",
        icon: "settings",
        keywords: "preferences",
        placeholder: "Search Settings",
        searchable: true,
        choices: SECTIONS.map((section) => ({ value: section.id, label: section.title })),
        run: ({ choice, trigger }) => {
          const section = SECTIONS.find((each) => each.id === choice?.value);
          if (section) now().settings(trigger, section.id);
        },
      },
      {
        id: "appearance",
        title: "Change appearance",
        description: "How localDot looks",
        group: "Settings",
        icon: "contrast",
        keywords: "theme colour color dark light daylight system",
        searchable: true,
        choices: APPEARANCES.map((each) => ({
          value: each.value,
          label: each.label,
          current: each.value === appearance.value,
        })),
        run: ({ choice }) => {
          const chosen = APPEARANCES.find((each) => each.value === choice?.value);
          if (chosen) now().appearance.change(chosen.value);
        },
      },
      {
        id: "other-dots",
        title: "Open another localDot",
        description: "Your other localDots on this Mac or elsewhere",
        group: "Settings",
        icon: "monitor",
        keywords: "switch instance computer",
        unavailable: otherDots.length ? undefined : "You have no other localDots",
        searchable: true,
        choices: otherDots.map((dot) => ({ value: dot.id, label: dot.name, detail: "localDot" })),
        run: ({ choice }) =>
          now()
            .otherDots.find((dot) => dot.id === choice?.value)
            ?.open(),
      },
      {
        id: "new-routine",
        title: "New routine",
        description: "Have dot do something on a schedule",
        group: "Settings",
        icon: "repeat",
        keywords: "schedule automate",
        run: ({ trigger }) => now().newRoutine(trigger),
      },
      {
        id: "stop-all",
        title: "Stop everything",
        description: "Stop every task and routine on this localDot",
        group: "Task",
        icon: "stop",
        keywords: "emergency halt all",
        unavailable: stopAllReason,
        run: doable((i) => i.stopAll),
      },
    ];
  }, [
    api,
    phone,
    sessionId,
    research,
    plans,
    otherDots,
    hasChatPanel,
    chatShown,
    modelGroups,
    modelCurrent,
    modelReason,
    persona.value,
    appearance.value,
    stopReason,
    continueReason,
    takeReason,
    handBackReason,
    newReason,
    replayReason,
    watchReason,
    filesReason,
    previewsReason,
    fullReason,
    fullOn,
    stopAllReason,
    conversationReason,
    currentConversation,
    facts,
    filedTag,
    filedPinned,
    filedArchived,
    underWay,
  ]);
  const suggested = [
    ...(stopReason ? [] : ["stop", "btw", "takeover"]),
    ...(handBackReason ? [] : ["handback"]),
    ...(continueReason ? [] : ["continue"]),
    "new",
    "resume",
    "model",
    "shortcuts",
    "settings",
  ];
  return { actions, suggested };
}
