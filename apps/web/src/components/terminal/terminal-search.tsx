"use client";

import { useState, useCallback } from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import { Input } from "@repo/ui/components/ui/input";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";

interface TerminalSearchProps {
  onSearch: (term: string) => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onClose: () => void;
  className?: string;
}

export function TerminalSearch({
  onSearch,
  onNext,
  onPrevious,
  onClose,
  className,
}: TerminalSearchProps) {
  const [query, setQuery] = useState("");

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
      onSearch(e.target.value);
    },
    [onSearch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter") {
        if (e.shiftKey) {
          onPrevious?.();
        } else {
          onNext?.();
        }
      }
    },
    [onClose, onNext, onPrevious],
  );

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md border bg-background px-2 py-1 shadow-sm",
        className,
      )}
    >
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Input
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
        className="h-7 border-0 bg-transparent px-1 text-sm focus-visible:ring-0"
        autoFocus
      />
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={onPrevious}
      >
        <ChevronUp className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onNext}>
        <ChevronDown className="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
