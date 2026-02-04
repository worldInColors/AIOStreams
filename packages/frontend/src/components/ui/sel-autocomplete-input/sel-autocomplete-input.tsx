'use client';

import { CursorContext, getCurrentContext } from '@/utils/sel-parser';
import {
  applySuggestion,
  generateSuggestions,
  Suggestion,
} from '@/utils/sel-suggestions';
import { cva } from 'class-variance-authority';
import * as React from 'react';
import {
  BasicField,
  BasicFieldOptions,
  extractBasicFieldProps,
} from '../basic-field';
import { Command, CommandGroup, CommandItem, CommandList } from '../command';
import { cn, defineStyleAnatomy } from '../core/styling';
import {
  extractInputPartProps,
  InputAddon,
  InputAnatomy,
  InputContainer,
  InputIcon,
  InputStyling,
} from '../input';

export const SELAutocompleteInputAnatomy = defineStyleAnatomy({
  root: cva(['UI-SELAutocompleteInput__root', 'relative w-full']),
  textarea: cva(
    ['UI-SELAutocompleteInput__textarea', 'w-full p-2 resize-none'],
    {
      variants: {
        size: {
          sm: 'h-20',
          md: 'h-32',
          lg: 'h-64',
        },
      },
      defaultVariants: {
        size: 'md',
      },
    }
  ),
  popover: cva([
    'UI-SELAutocompleteInput__popover',
    'fixed z-[9999] min-w-[280px] max-w-[400px]',
    'rounded-md border bg-[--paper] shadow-lg',
    'overflow-hidden',
  ]),
  suggestion: cva([
    'UI-SELAutocompleteInput__suggestion',
    'flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer',
    'hover:bg-[--subtle]',
    'data-[selected=true]:bg-[--subtle]',
  ]),
  typeIcon: cva([
    'UI-SELAutocompleteInput__typeIcon',
    'w-5 h-5 flex items-center justify-center flex-shrink-0',
    'text-xs font-mono text-[--muted] bg-[--subtle] rounded',
  ]),
  description: cva([
    'UI-SELAutocompleteInput__description',
    'text-xs text-[--muted] truncate ml-auto',
  ]),
});

interface CaretCoordinates {
  top: number;
  left: number;
  height: number;
}

const MIRROR_CSS_PROPS = [
  'boxSizing',
  'width',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'whiteSpace',
  'wordWrap',
  'wordBreak',
] as const;

function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number
): CaretCoordinates {
  const computed = window.getComputedStyle(textarea);
  const lineHeight =
    parseInt(computed.lineHeight) || parseInt(computed.fontSize) * 1.2;

  // Create a hidden mirror div
  const mirror = document.createElement('div');
  mirror.style.position = 'absolute';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';

  for (const prop of MIRROR_CSS_PROPS) {
    (mirror.style as any)[prop] = computed.getPropertyValue(
      prop.replace(/([A-Z])/g, '-$1').toLowerCase()
    );
  }
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = 'auto';
  mirror.style.minHeight = '1em';

  const textBefore = textarea.value.substring(0, position);
  mirror.textContent = textBefore;

  // marker span for caret position
  const marker = document.createElement('span');
  marker.textContent = '|';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const coords: CaretCoordinates = {
    top: marker.offsetTop,
    left: marker.offsetLeft,
    height: lineHeight,
  };

  document.body.removeChild(mirror);

  return coords;
}

export type SELAutocompleteInputProps = Omit<
  React.ComponentPropsWithRef<'textarea'>,
  'size' | 'onChange'
> &
  InputStyling &
  BasicFieldOptions & {
    value?: string;
    onChange?: (value: string) => void;
    onValueChange?: (value: string) => void;
    size?: 'sm' | 'md' | 'lg';
    rows?: number;
    debounceDelay?: number;
  };

export const SELAutocompleteInput = React.forwardRef<
  HTMLTextAreaElement,
  SELAutocompleteInputProps
>((props, ref) => {
  const [props1, basicFieldProps] =
    extractBasicFieldProps<SELAutocompleteInputProps>(props, React.useId());

  const {
    className,
    value: controlledValue,
    onChange,
    onValueChange,
    size = 'md',
    rows,
    debounceDelay = 100,
    leftAddon,
    leftIcon,
    rightAddon,
    rightIcon,
    intent,
    ...rest
  } = props1;

  const [
    ,
    {
      inputContainerProps,
      leftAddonProps,
      leftIconProps,
      rightAddonProps,
      rightIconProps,
    },
  ] = extractInputPartProps<SELAutocompleteInputProps>({
    ...props1,
    size: size ?? 'md',
    intent: intent ?? 'basic',
    leftAddon,
    leftIcon,
    rightAddon,
    rightIcon,
  });

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const combinedRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  const [internalValue, setInternalValue] = React.useState('');
  const value = controlledValue ?? internalValue;
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [popoverStyle, setPopoverStyle] = React.useState<React.CSSProperties>(
    {}
  );
  const [cursorContext, setCursorContext] =
    React.useState<CursorContext | null>(null);

  const updateSuggestions = React.useCallback(
    (text: string, cursorPos: number) => {
      const context = getCurrentContext(text, cursorPos);
      setCursorContext(context);

      if (context.inExpression) {
        const newSuggestions = generateSuggestions(context, text);
        setSuggestions(newSuggestions);
        setShowSuggestions(newSuggestions.length > 0);
        setSelectedIndex(0);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    },
    []
  );

  const updatePopoverPosition = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const caretCoords = getCaretCoordinates(textarea, cursorPos);
    const rect = textarea.getBoundingClientRect();

    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    let top = rect.top + caretCoords.top - scrollTop + caretCoords.height + 4;
    let left = rect.left + caretCoords.left - scrollLeft;

    const popoverWidth = 300;
    const popoverHeight = 220;

    if (left + popoverWidth > window.innerWidth - 16) {
      left = window.innerWidth - popoverWidth - 16;
    }
    if (left < 16) left = 16;

    // Show above if not enough space below
    if (top + popoverHeight > window.innerHeight - 16) {
      top = rect.top + caretCoords.top - scrollTop - popoverHeight - 4;
    }
    if (top < 16) top = 16;

    setPopoverStyle({ top, left });
  }, []);

  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPos = e.target.selectionStart;

      setInternalValue(newValue);
      onChange?.(newValue);
      onValueChange?.(newValue);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      const lastChar = newValue[cursorPos - 1];
      const lastTwoChars = newValue.slice(cursorPos - 2, cursorPos);
      // Trigger immediately for { . and ::
      if (lastChar === '{' || lastChar === '.' || lastTwoChars === '::') {
        updateSuggestions(newValue, cursorPos);
        updatePopoverPosition();
      } else {
        debounceRef.current = setTimeout(() => {
          updateSuggestions(newValue, cursorPos);
          updatePopoverPosition();
        }, debounceDelay);
      }
    },
    [
      onChange,
      onValueChange,
      updateSuggestions,
      updatePopoverPosition,
      debounceDelay,
    ]
  );

  const handleSelect = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      updateSuggestions(value, textarea.selectionStart);
      updatePopoverPosition();
    }, debounceDelay);
  }, [value, updateSuggestions, updatePopoverPosition, debounceDelay]);

  // Scroll selected item into view
  const scrollSelectedIntoView = React.useCallback((index: number) => {
    const popover = popoverRef.current;
    if (!popover) return;

    const items = popover.querySelectorAll('[data-suggestion-item]');
    const item = items[index] as HTMLElement;
    if (item) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, []);

  const selectSuggestion = React.useCallback(
    (suggestion: Suggestion) => {
      if (!cursorContext) return;

      const { newTemplate, newCursorPosition } = applySuggestion(
        value,
        cursorContext,
        suggestion
      );

      setInternalValue(newTemplate);
      onChange?.(newTemplate);
      onValueChange?.(newTemplate);

      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(newCursorPosition, newCursorPosition);

          if (suggestion.type === 'object') {
            updateSuggestions(newTemplate, newCursorPosition);
            updatePopoverPosition();
          } else {
            setShowSuggestions(false);
          }
        }
      }, 0);
    },
    [
      value,
      cursorContext,
      onChange,
      onValueChange,
      updateSuggestions,
      updatePopoverPosition,
    ]
  );

  const maxDisplayed = 12;
  const displayedSuggestions = suggestions.slice(0, maxDisplayed);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!showSuggestions || displayedSuggestions.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => {
            // Clamp to valid range
            const newIndex = Math.min(i + 1, displayedSuggestions.length - 1);
            setTimeout(() => scrollSelectedIntoView(newIndex), 0);
            return newIndex;
          });
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => {
            const newIndex = Math.max(i - 1, 0);
            setTimeout(() => scrollSelectedIntoView(newIndex), 0);
            return newIndex;
          });
          break;
        case 'Tab':
        case 'Enter':
          if (displayedSuggestions[selectedIndex]) {
            e.preventDefault();
            selectSuggestion(displayedSuggestions[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setShowSuggestions(false);
          break;
      }
    },
    [
      showSuggestions,
      displayedSuggestions,
      selectedIndex,
      scrollSelectedIntoView,
      selectSuggestion,
    ]
  );

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close popover when page scrolls
  React.useEffect(() => {
    if (!showSuggestions) return;

    const handleScroll = (e: Event) => {
      if (e.target === textareaRef.current) return;
      if (popoverRef.current?.contains(e.target as Node)) return;

      setShowSuggestions(false);
    };

    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [showSuggestions]);

  React.useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  React.useEffect(() => {
    if (showSuggestions) updatePopoverPosition();
  }, [showSuggestions, updatePopoverPosition]);

  return (
    <BasicField {...basicFieldProps}>
      <div
        ref={containerRef}
        className={cn(SELAutocompleteInputAnatomy.root(), className)}
      >
        <InputContainer {...inputContainerProps}>
          <InputAddon {...leftAddonProps} />
          <InputIcon {...leftIconProps} />

          <textarea
            ref={combinedRef}
            id={basicFieldProps.id}
            name={basicFieldProps.name}
            className={cn(
              'form-textarea',
              InputAnatomy.root({
                size,
                intent: intent ?? 'basic',
                hasError: !!basicFieldProps.error,
                isDisabled: !!basicFieldProps.disabled,
                isReadonly: !!basicFieldProps.readonly,
                hasRightAddon: !!rightAddon,
                hasRightIcon: !!rightIcon,
                hasLeftAddon: !!leftAddon,
                hasLeftIcon: !!leftIcon,
              }),
              SELAutocompleteInputAnatomy.textarea({ size })
            )}
            value={value}
            onChange={handleChange}
            onSelect={handleSelect}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            disabled={basicFieldProps.disabled || basicFieldProps.readonly}
            data-disabled={basicFieldProps.disabled}
            rows={rows}
            {...rest}
          />

          <InputAddon {...rightAddonProps} />
          <InputIcon {...rightIconProps} />
        </InputContainer>

        {showSuggestions && displayedSuggestions.length > 0 && (
          <div
            ref={popoverRef}
            className={cn(SELAutocompleteInputAnatomy.popover())}
            style={popoverStyle}
          >
            <Command className="bg-transparent" shouldFilter={false}>
              <CommandList className="max-h-[200px]">
                <CommandGroup>
                  {displayedSuggestions.map((suggestion, index) => (
                    <CommandItem
                      key={suggestion.path}
                      className={cn(
                        SELAutocompleteInputAnatomy.suggestion(),
                        index === selectedIndex && 'bg-[--subtle]'
                      )}
                      onSelect={() => selectSuggestion(suggestion)}
                      data-selected={index === selectedIndex}
                      data-suggestion-item
                    >
                      <span
                        className={cn(SELAutocompleteInputAnatomy.typeIcon())}
                      >
                        {suggestion.typeIcon}
                      </span>
                      <span className="font-medium truncate">
                        {suggestion.matchHighlight ? (
                          <>
                            {suggestion.label.slice(
                              0,
                              suggestion.matchHighlight.start
                            )}
                            <span className="text-[--brand] font-semibold">
                              {suggestion.label.slice(
                                suggestion.matchHighlight.start,
                                suggestion.matchHighlight.end
                              )}
                            </span>
                            {suggestion.label.slice(
                              suggestion.matchHighlight.end
                            )}
                          </>
                        ) : (
                          suggestion.label
                        )}
                      </span>
                      {suggestion.description && (
                        <span
                          className={cn(
                            SELAutocompleteInputAnatomy.description()
                          )}
                        >
                          {suggestion.description}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        )}
      </div>
    </BasicField>
  );
});

SELAutocompleteInput.displayName = 'SELAutocompleteInput';
