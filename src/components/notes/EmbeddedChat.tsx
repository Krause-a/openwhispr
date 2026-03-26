import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X, PanelRight, PanelRightClose } from "lucide-react";
import { cn } from "../lib/utils";
import { ChatMessages } from "../chat/ChatMessages";
import { ChatInput } from "../chat/ChatInput";
import type { Message, AgentState } from "../chat/types";

export type EmbeddedChatMode = "hidden" | "floating" | "sidebar";

interface EmbeddedChatProps {
  mode: EmbeddedChatMode;
  onModeChange: (mode: EmbeddedChatMode) => void;
  messages: Message[];
  agentState: AgentState;
  onTextSubmit: (text: string) => void;
  onCancel: () => void;
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center h-full select-none">
      <p className="text-xs text-foreground/30 dark:text-foreground/20 text-center max-w-44">
        {t("embeddedChat.emptyState")}
      </p>
    </div>
  );
}

export default function EmbeddedChat({
  mode,
  onModeChange,
  messages,
  agentState,
  onTextSubmit,
  onCancel,
}: EmbeddedChatProps) {
  const { t } = useTranslation();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode === "floating") {
        onModeChange("hidden");
      }
    },
    [mode, onModeChange]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (mode === "hidden") return null;

  const header = (
    <div className="h-9 flex items-center px-3 shrink-0">
      <span className="text-xs font-medium text-foreground/50">
        {t("embeddedChat.title")}
      </span>
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        {mode === "floating" ? (
          <button
            onClick={() => onModeChange("sidebar")}
            className="h-6 w-6 flex items-center justify-center rounded-md text-foreground/25 hover:text-foreground/40 hover:bg-foreground/6 transition-colors"
            aria-label={t("embeddedChat.dock")}
          >
            <PanelRight size={13} />
          </button>
        ) : (
          <button
            onClick={() => onModeChange("floating")}
            className="h-6 w-6 flex items-center justify-center rounded-md text-foreground/25 hover:text-foreground/40 hover:bg-foreground/6 transition-colors"
            aria-label={t("embeddedChat.undock")}
          >
            <PanelRightClose size={13} />
          </button>
        )}
        <button
          onClick={() => onModeChange("hidden")}
          className="h-6 w-6 flex items-center justify-center rounded-md text-foreground/25 hover:text-foreground/40 hover:bg-foreground/6 transition-colors"
          aria-label={t("embeddedChat.close")}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );

  const chatContent = (
    <>
      {header}
      <ChatMessages messages={messages} emptyState={<EmptyState />} />
      <ChatInput
        agentState={agentState}
        partialTranscript=""
        onTextSubmit={onTextSubmit}
        onCancel={onCancel}
        showHotkey={false}
        autoFocus={false}
      />
    </>
  );

  if (mode === "floating") {
    return (
      <div
        className={cn(
          "absolute bottom-20 right-4 z-20",
          "w-95 max-h-120 min-h-50",
          "flex flex-col",
          "bg-background/95 dark:bg-surface-2/95",
          "border border-border/20 dark:border-white/8",
          "rounded-xl",
          "shadow-elevated",
          "backdrop-blur-2xl",
          "animate-[scale-in_200ms_ease-out]"
        )}
      >
        {chatContent}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "w-85 shrink-0",
        "border-l border-border/15 dark:border-white/6",
        "flex flex-col",
        "min-h-0"
      )}
    >
      {chatContent}
    </div>
  );
}
