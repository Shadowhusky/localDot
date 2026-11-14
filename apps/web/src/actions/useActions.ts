import { CONVERSATION_TAGS, ConversationList, PERSONAS, type PersonaId } from "@localdot/protocol";
import { useMemo, useRef } from "react";
import {
  conversationStatus,
  conversationTitle,
  type LiveFacts,
  type Organize,
  organizeConversation,
  STATUS_LABEL,
  tagIds,
  tagOf,
  toggledTag,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import { researchQuestion } from "../agent/research.ts";
import { personaBlurb, personaName } from "../dot/persona-words.ts";
import { t, tr } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { APPEARANCE_NAMES } from "../onboarding/AppearancePicker.tsx";
import { APPEARANCE_CHOICES, type AppearanceChoice } from "../onboarding/appearance.ts";
import { addEntry, MemoryRequestError } from "../settings/memory/memory-api.ts";
import type { ModelGroup, ModelOption } from "../settings/model-options.ts";
import { SECTIONS, type SettingsSection } from "../settings/sections.ts";
import { PANEL_NAME } from "../shell/panel-name.ts";
import { VIEW_NAMES } from "../shell/view-style.ts";
import { announce } from "../ui/Announcer.tsx";
import { TAG_NAMES, tagName } from "../ui/ConversationTag.tsx";
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
    // Sorts the conversations into tags with the user's model.
    sortTags(): void;
  };
  readonly replay: Doable;
  readonly watch: Doable;
  // Every conversation's screen and progress at once.
  readonly overview: Doable;
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
  // Over to the other view style.
  readonly viewStyle: { readonly label: string; run(): void };
  readonly otherDots: readonly { readonly id: string; readonly name: string; open(): void }[];
  readonly stopAll: Doable;
  newRoutine(trigger: HTMLElement | null): void;
  shortcuts(): void;
}

const APPEARANCES = APPEARANCE_CHOICES.map((value) => ({ value, label: APPEARANCE_NAMES[value] }));
const RENAME_MAX = 80;
const MEMORY_PROBLEMS: Partial<Record<string, string>> = {
  invalid: tr("dot can't keep that. Keep it under 1,000 characters, with no keys in it."),
  busy: tr("Memory can't change right now. Try again in a moment."),
  full: tr("Memory is full. Remove something in Settings → What dot knows first."),
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
    viewStyle,
    conversations,
  } = input;
  const stopReason = input.stop.reason;
  const continueReason = input.continue.reason;
  const takeReason = input.take.reason;
  const handBackReason = input.handBack.reason;
  const newReason = input.newConversation.reason;
  const replayReason = input.replay.reason;
  const watchReason = input.watch.reason;
  const overviewReason = input.overview.reason;
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
  const recentList = useRecentConversations(api, false);
  const recent = recentList.entries;
  const library = recentList.tags;
  const archived = useRecentConversations(api, false, "archived").entries;
  const filed = [...recent, ...archived].find((entry) =>
    entry.sessions.includes(currentConversation ?? ""),
  );
  const filedTags = tagIds(filed);
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
    const noConversation = currentConversation ? undefined : t`Start a conversation first`;
    const organize = async (change: Organize, done: string) => {
      const id = now().conversations.current;
      if (!id) return t`Start a conversation first.`;
      try {
        await organizeConversation(api, id, change);
      } catch {
        return t`That change couldn't be saved. Try again.`;
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
        title: t`Ask a side question`,
        description: t`Look into this task, its log, screen and files, without interrupting it. dot never sees it.`,
        hint: t`<question>`,
        group: "Task",
        icon: "message-circle",
        keywords: "by the way aside side question quick look check",
        input: "required",
        placeholder: t`Ask about this task…`,
        unavailable: sessionId ? undefined : t`Start a task first`,
        run: ({ text }) => now().aside.ask(text),
      },
      {
        id: "stop",
        command: "stop",
        title: t`Stop the task`,
        description: t`Stop dot's current task`,
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
        title: t`Continue the task`,
        description: t`Carry on a paused or interrupted task`,
        group: "Task",
        icon: "continue",
        keywords: "resume unpause carry on",
        unavailable: continueReason,
        run: doable((i) => i.continue),
      },
      {
        id: "takeover",
        command: "takeover",
        title: t`Take control`,
        description: t`Use the computer yourself while dot waits`,
        group: "Task",
        icon: "hand",
        keywords: "take over control computer myself",
        unavailable: takeReason,
        run: doable((i) => i.take),
      },
      {
        id: "handback",
        command: "handback",
        title: t`Hand back`,
        description: t`Give the computer back to dot`,
        group: "Task",
        icon: "hand-back",
        keywords: "give back return control",
        unavailable: handBackReason,
        run: doable((i) => i.handBack),
      },
      {
        id: "new",
        command: "new",
        title: t`New conversation`,
        description: t`Start afresh; this conversation stays in the list`,
        group: "Conversation",
        icon: "compose",
        keywords: "clear fresh start",
        unavailable: newReason,
        run: doable((i) => i.newConversation),
      },
      {
        id: "resume",
        command: "resume",
        title: t`Switch conversation`,
        description: t`Pick up an earlier conversation where it left off`,
        hint: t`[search]`,
        group: "Conversation",
        icon: "message-circle",
        keywords: "open continue history conversations chats earlier",
        placeholder: t`Search conversations`,
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
        title: t`Rename this conversation`,
        description: t`Give it a name of your own, or let dot name it again`,
        hint: t`[name]`,
        group: "Conversation",
        icon: "file-text",
        keywords: "title name",
        input: "optional",
        placeholder: t`A name for this conversation`,
        unavailable: currentConversation ? undefined : t`Start a conversation first`,
        choices: [{ value: "auto", label: t`Use the automatic title`, detail: t`dot names it` }],
        run: async ({ text, choice }) => {
          const id = now().conversations.current;
          if (!id) return t`Start a conversation first.`;
          const title = choice?.value === "auto" ? null : text.trim();
          if (title !== null && (!title || title.length > RENAME_MAX))
            return t`Use a name of 1–${RENAME_MAX} characters.`;
          try {
            await api.post(`/api/conversations/${id}/title`, { title });
          } catch {
            return t`Couldn't rename the conversation. Try again.`;
          }
          now().conversations.renamed();
          announce(
            "conversation",
            title ? t`Renamed to ${title}.` : t`dot names this conversation.`,
          );
          return undefined;
        },
      },
      {
        id: "tag",
        command: "tag",
        title: t`Tag this conversation`,
        description: t`Give it a tag or take one off, to find it by in the list`,
        hint: t`[tag]`,
        group: "Conversation",
        icon: "tag",
        keywords: "colour color label mark category",
        placeholder: t`Search tags`,
        unavailable: noConversation,
        choices: [
          { value: "none", label: t`No tag`, current: !filedTags.length },
          ...CONVERSATION_TAGS.map((tag) => ({
            value: tag,
            label: TAG_NAMES[tag],
            current: filedTags.includes(tag),
          })),
          ...library.map((tag) => ({
            value: tag.id,
            label: tag.name,
            current: filedTags.includes(tag.id),
          })),
        ],
        run: ({ choice }) => {
          if (!choice) return undefined;
          const id = choice.value === "none" ? null : choice.value;
          const next = toggledTag(filedTags, id);
          const tag = id ? tagOf(id, library) : undefined;
          if (!tag) return organize({ tags: next }, t`Tag taken off.`);
          return organize(
            { tags: next },
            next.includes(tag.id) ? t`Tagged ${tagName(tag)}.` : t`${tagName(tag)} taken off.`,
          );
        },
      },
      {
        id: "sort-tags",
        command: "sort",
        title: t`Sort conversations into tags`,
        description: t`Your model reads them and tags each`,
        group: "Conversation",
        icon: "bot",
        keywords: "smart tags categorize categorise organize group auto",
        run: () => {
          now().conversations.sortTags();
          return undefined;
        },
      },
      {
        id: "pin",
        command: "pin",
        title: filedPinned ? t`Unpin this conversation` : t`Pin this conversation`,
        description: filedPinned
          ? t`Let it move down the list with the rest`
          : t`Keep it at the top of the list`,
        group: "Conversation",
        icon: "pin",
        keywords: "top favourite favorite star keep",
        unavailable: noConversation,
        run: () =>
          organize(
            { pinned: !filedPinned },
            filedPinned ? t`Unpinned this conversation.` : t`Pinned to the top.`,
          ),
      },
      {
        id: "archive",
        command: "archive",
        title: filedArchived ? t`Unarchive this conversation` : t`Archive this conversation`,
        description: filedArchived
          ? t`Bring it back to the list`
          : t`Put it away; it comes back if it goes on`,
        group: "Conversation",
        icon: filedArchived ? "archive-restore" : "archive",
        keywords: "hide put away tidy",
        unavailable:
          noConversation ??
          (underWay && !filedArchived
            ? t`Stop the task before archiving its conversation`
            : undefined),
        run: () =>
          organize(
            { archived: !filedArchived },
            filedArchived ? t`Back in the list.` : t`Archived. It's under Archived in the list.`,
          ),
      },
      {
        id: "delete-conversation",
        title: t`Delete this conversation`,
        description: t`Its messages, recordings and screenshots, for good`,
        group: "Conversation",
        icon: "trash",
        keywords: "remove erase forget",
        unavailable:
          noConversation ??
          (underWay ? t`Stop the task before deleting its conversation` : undefined),
        run: ({ trigger }) => now().conversations.remove(trigger),
      },
      {
        id: "replay",
        command: "replay",
        title: t`Open Replay`,
        description: t`Watch this task back, or browse your recordings`,
        group: "Conversation",
        icon: "history",
        keywords: "recording video watch back history",
        unavailable: replayReason,
        run: doable((i) => i.replay),
      },
      {
        id: "research",
        command: "research",
        title: t`Research a question`,
        description: t`dot reads many sources and writes a cited report`,
        hint: t`<question>`,
        group: "Task",
        icon: "globe",
        keywords: "search web report sources",
        input: "required",
        placeholder: t`What should dot research?`,
        unavailable: research,
        run: ({ text }) => researchQuestion(text),
      },
      {
        id: "model",
        command: "model",
        title: t`Switch model`,
        description: t`Choose the model dot works with`,
        hint: t`[name]`,
        group: "dot",
        icon: "cpu",
        keywords: "llm provider claude gpt",
        placeholder: t`Search models`,
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
        title: t`Switch dot`,
        description: t`Choose which dot works with you, from the next task`,
        hint: t`[name]`,
        group: "dot",
        icon: "smile",
        keywords: "persona character",
        placeholder: t`Search dots`,
        searchable: true,
        choices: Object.values(PERSONAS).map((each) => ({
          value: each.id,
          label: personaName(each.id),
          detail: personaBlurb(each.id),
          current: each.id === persona.value,
        })),
        run: ({ choice }) => {
          const chosen = Object.values(PERSONAS).find((each) => each.id === choice?.value);
          if (!chosen) return;
          now().persona.choose(chosen.id);
          announce("persona", t`${chosen.name} works with you from the next task.`);
        },
      },
      {
        id: "remember",
        command: "remember",
        title: t`Remember something`,
        description: t`Save a fact dot keeps for every task`,
        hint: t`<fact>`,
        group: "dot",
        icon: "book",
        keywords: "memory note fact know",
        input: "required",
        placeholder: t`What should dot remember?`,
        run: async ({ text }) => {
          try {
            await addEntry(api, "MEMORY.md", text);
          } catch (error) {
            return (
              (error instanceof MemoryRequestError && MEMORY_PROBLEMS[error.reason]) ||
              t`Couldn't save that. Try again.`
            );
          }
          showToast({
            title: t`dot will remember that`,
            action: { label: t`View`, onAction: () => now().settings(null, "knowledge") },
          });
          return undefined;
        },
      },
      {
        id: "usage",
        command: "usage",
        title: t`Show plan usage`,
        description: t`How much of your ChatGPT or Claude plan is used`,
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
        title: t`Report a problem`,
        description: t`Tell the localDot team what went wrong`,
        hint: t`[what happened]`,
        group: "Help",
        icon: "circle-alert",
        keywords: "bug feedback issue",
        input: "optional",
        run: ({ text, trigger }) => now().report(trigger, text || undefined),
      },
      {
        id: "help",
        command: "help",
        title: t`Show commands`,
        description: t`List every command you can type after /`,
        group: "Help",
        icon: "info",
        keywords: "commands slash list",
        run: () => fillComposer("/"),
      },
      {
        id: "shortcuts",
        command: "shortcuts",
        title: t`Keyboard shortcuts`,
        description: t`Every key that does something here`,
        group: "Help",
        icon: "keyboard",
        keywords: "keys hotkeys",
        keys: ["?"],
        run: () => now().shortcuts(),
      },
      {
        id: "watch",
        title: t`Go to Watch`,
        description: t`The live computer and this conversation`,
        group: "Go to",
        icon: "monitor",
        keywords: "live leave replay",
        unavailable: watchReason,
        run: doable((i) => i.watch),
      },
      {
        id: "overview",
        title: t`Show the overview`,
        description: t`Every dot's screen and progress at once`,
        group: "Go to",
        icon: "layout-dashboard",
        keywords: "grid tiles all dots conversations tasks screens dashboard",
        unavailable: overviewReason,
        run: doable((i) => i.overview),
      },
      {
        id: "view-chat",
        title: t`Show the chat`,
        description: t`This conversation`,
        group: "Go to",
        icon: "message-circle",
        keywords: "thread messages tab",
        run: () => now().view("chat"),
      },
      {
        id: "view-activity",
        title: t`Show ${PANEL_NAME}`,
        description: t`Steps, files and previews of this work`,
        group: "Go to",
        icon: "list",
        keywords: "activity steps timeline tab",
        run: () => now().view("activity"),
      },
      {
        id: "files",
        title: t`Show files`,
        description: t`Files dot made or changed in this conversation`,
        group: "Go to",
        icon: "file",
        keywords: "downloads results outputs activity",
        unavailable: filesReason,
        run: doable((i) => i.files),
      },
      {
        id: "previews",
        title: t`Show previews`,
        description: t`Apps dot started on its computer`,
        group: "Go to",
        icon: "app-window",
        keywords: "dev server preview localhost activity",
        unavailable: previewsReason,
        run: doable((i) => i.previews),
      },
      {
        id: "view-routines",
        title: t`Show Routines`,
        description: t`Tasks dot runs on a schedule`,
        group: "Go to",
        icon: "repeat",
        keywords: "schedule tab",
        run: () => now().view("routines"),
      },
      ...(hasChatPanel
        ? [
            {
              id: "chat-panel",
              title: chatShown ? t`Hide the conversation panel` : t`Show the conversation panel`,
              description: t`Give the computer the whole width, or bring the chat back`,
              group: "Go to",
              icon: "panel-right",
              keywords: "toggle sidebar rail chat",
              run: () => now().chatPanel?.toggle(),
            } satisfies Action,
          ]
        : []),
      {
        id: "full-screen",
        title: fullOn ? t`Leave full screen` : t`Full screen`,
        description: t`The computer's screen on its own`,
        group: "Go to",
        icon: fullOn ? "shrink" : "expand",
        keywords: "fullscreen focus",
        keys: phone ? undefined : ["Mod", "Shift", "F"],
        unavailable: fullReason,
        run: doable((i) => i.fullScreen),
      },
      {
        id: "settings",
        title: t`Open Settings`,
        description: t`Models, autonomy, keys and more`,
        group: "Settings",
        icon: "settings",
        keywords: "preferences options",
        run: ({ trigger }) => now().settings(trigger),
      },
      {
        id: "settings-section",
        title: t`Settings section`,
        description: t`Go straight to one part of Settings`,
        group: "Settings",
        icon: "settings",
        keywords: "preferences",
        placeholder: t`Search Settings`,
        searchable: true,
        choices: SECTIONS.map((section) => ({ value: section.id, label: section.title })),
        run: ({ choice, trigger }) => {
          const section = SECTIONS.find((each) => each.id === choice?.value);
          if (section) now().settings(trigger, section.id);
        },
      },
      {
        id: "appearance",
        title: t`Change appearance`,
        description: t`How localDot looks`,
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
        id: "view-style",
        title: viewStyle.label,
        description: t`${VIEW_NAMES.chat} or ${VIEW_NAMES.studio}, on this device`,
        group: "Settings",
        icon: "layout-grid",
        keywords: `view style layout messenger switch ${VIEW_NAMES.chat} ${VIEW_NAMES.studio}`,
        searchable: true,
        run: () => now().viewStyle.run(),
      },
      {
        id: "other-dots",
        title: t`Open another localDot`,
        description: t`Your other localDots on this Mac or elsewhere`,
        group: "Settings",
        icon: "monitor",
        keywords: "switch instance computer",
        unavailable: otherDots.length ? undefined : t`You have no other localDots`,
        searchable: true,
        choices: otherDots.map((dot) => ({ value: dot.id, label: dot.name, detail: "localDot" })),
        run: ({ choice }) =>
          now()
            .otherDots.find((dot) => dot.id === choice?.value)
            ?.open(),
      },
      {
        id: "new-routine",
        title: t`New routine`,
        description: t`Have dot do something on a schedule`,
        group: "Settings",
        icon: "repeat",
        keywords: "schedule automate",
        run: ({ trigger }) => now().newRoutine(trigger),
      },
      {
        id: "stop-all",
        title: t`Stop everything`,
        description: t`Stop every task and routine on this localDot`,
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
    viewStyle.label,
    stopReason,
    continueReason,
    takeReason,
    handBackReason,
    newReason,
    replayReason,
    watchReason,
    overviewReason,
    filesReason,
    previewsReason,
    fullReason,
    fullOn,
    stopAllReason,
    conversationReason,
    currentConversation,
    facts,
    filedTags.join(),
    library,
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
