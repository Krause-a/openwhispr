import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Mic, SendHorizontal } from "lucide-react";
import { cn } from "../lib/utils";
import DictationWidget from "./DictationWidget";

interface NoteBottomBarProps {
  isRecording: boolean;
  isProcessing: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onAskSubmit: (text: string) => void;
  askDisabled?: boolean;
  actionPicker?: React.ReactNode;
}

export default function NoteBottomBar({
  isRecording,
  isProcessing,
  onStartRecording,
  onStopRecording,
  onAskSubmit,
  askDisabled,
  actionPicker,
}: NoteBottomBarProps) {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || askDisabled) return;
    onAskSubmit(text);
    setInputText("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [inputText, askDisabled, onAskSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  if (isRecording || isProcessing) {
    return (
      <DictationWidget
        isRecording={isRecording}
        isProcessing={isProcessing}
        onStart={onStartRecording}
        onStop={onStopRecording}
        actionPicker={actionPicker}
      />
    );
  }

  return (
    <div className="absolute bottom-5 left-0 right-0 z-10 flex justify-center pointer-events-none">
      <div
        className={cn(
          "flex items-center h-12 px-2 gap-2 pointer-events-auto",
          "rounded-xl",
          "bg-background/80 dark:bg-surface-1/80",
          "backdrop-blur-xl",
          "border border-border/15 dark:border-white/8",
          "shadow-sm"
        )}
      >
        <button
          onClick={onStartRecording}
          className={cn(
            "flex items-center justify-center w-11 h-11 rounded-full",
            "bg-primary/8 dark:bg-primary/12",
            "backdrop-blur-xl",
            "border border-primary/15 dark:border-primary/20",
            "shadow-sm hover:shadow-md",
            "text-primary/60 hover:text-primary",
            "transition-all duration-200",
            "hover:bg-primary/14 dark:hover:bg-primary/20",
            "hover:scale-105",
            "active:scale-[0.97]"
          )}
          aria-label={t("notes.editor.transcribe")}
        >
          <Mic size={16} />
        </button>

        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={askDisabled}
          placeholder={t("embeddedChat.askPlaceholder")}
          className={cn(
            "input-inline flex-1 bg-transparent outline-none min-w-0 p-0",
            "text-[13px] text-foreground placeholder:text-muted-foreground/30"
          )}
        />

        {inputText.trim() && (
          <button
            onClick={handleSubmit}
            disabled={askDisabled}
            className={cn(
              "p-1 rounded-sm shrink-0",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
              "transition-colors duration-100",
              "text-primary hover:text-primary/80"
            )}
            aria-label={t("embeddedChat.send")}
          >
            <SendHorizontal size={14} />
          </button>
        )}

        {actionPicker}
      </div>
    </div>
  );
}
