/**
 * Variation Comments — inline conversation thread for a single variation.
 *
 * Chat-like layout: provider messages right-aligned (blue), RESO admin
 * messages left-aligned (gray). Each comment has timestamp, author,
 * message text, and optional attachments.
 *
 * Comments are stored in the localStorage draft until the user saves
 * the entire variations report.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ── Types ────────────────────────────────────────────────────────────

export interface VariationComment {
  readonly timestamp: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly attachments?: ReadonlyArray<{ readonly displayText: string; readonly url: string }>;
}

interface VariationCommentsProps {
  /** Existing comments from the service (previous saves). */
  readonly existingComments: ReadonlyArray<VariationComment>;
  /** Draft comments from localStorage (not yet saved). */
  readonly draftComments: ReadonlyArray<VariationComment>;
  /** Called when a new comment is added to the draft. */
  readonly onAddComment: (comment: VariationComment) => void;
  /** Called when a draft comment is removed. */
  readonly onRemoveComment: (index: number) => void;
  /** The current user's display name. */
  readonly userName: string;
  /** The current user's provider UOI. */
  readonly userUoi: string;
  /** Whether the report is in read-only mode (locked by another user). */
  readonly isReadOnly: boolean;
}

const RESO_ADMIN_UOI = 'RESO';

// ── Component ────────────────────────────────────────────────────────

export const VariationComments = ({
  existingComments,
  draftComments,
  onAddComment,
  onRemoveComment,
  userName,
  userUoi,
  isReadOnly,
}: VariationCommentsProps) => {
  // Default open: when reviewers reopen a variation that's already
  // accumulated comments, surfacing the thread without an extra click
  // matches what they're trying to do (read recent context). The toggle
  // stays available for users who want to collapse a long thread.
  const [expanded, setExpanded] = useState(true);
  const [message, setMessage] = useState('');
  const [attachUrl, setAttachUrl] = useState('');
  const [attachText, setAttachText] = useState('');
  const [showAttach, setShowAttach] = useState(false);
  const [attachments, setAttachments] = useState<ReadonlyArray<{ displayText: string; url: string }>>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allComments = [...existingComments, ...draftComments];
  const totalCount = allComments.length;

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [message]);

  // Scroll the message list to the latest comment whenever it expands
  // or new entries arrive — newest comment is the most relevant context.
  useEffect(() => {
    if (!expanded || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [expanded, totalCount]);

  const handleSubmit = useCallback(() => {
    if (!message.trim()) return;

    const comment: VariationComment = {
      timestamp: new Date().toISOString(),
      from: userUoi,
      to: RESO_ADMIN_UOI,
      message: message.trim(),
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    };

    onAddComment(comment);
    setMessage('');
    setAttachments([]);
    setShowAttach(false);
  }, [message, attachments, userUoi, onAddComment]);

  const handleAddAttachment = useCallback(() => {
    if (!attachUrl.trim()) return;

    try {
      new URL(attachUrl);
    } catch {
      return;
    }

    if (!attachUrl.startsWith('https://')) return;

    setAttachments(prev => [...prev, { displayText: attachText.trim() || attachUrl, url: attachUrl }]);
    setAttachUrl('');
    setAttachText('');
    setShowAttach(false);
  }, [attachUrl, attachText]);

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  }, []);

  const isResoMessage = (comment: VariationComment): boolean =>
    comment.from === RESO_ADMIN_UOI;

  const isDraft = (index: number): boolean =>
    index >= existingComments.length;

  return (
    <div className="border-t border-gray-100 dark:border-gray-700/50 flex flex-col min-h-0 flex-1">
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-4 py-1.5 text-[10px] text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
      >
        <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
        </svg>
        Comments{totalCount > 0 && ` (${totalCount})`}
        {draftComments.length > 0 && (
          <span className="text-amber-500 dark:text-amber-400 font-medium">
            +{draftComments.length} unsaved
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 flex flex-col gap-2 flex-1 min-h-0">
          {/* Message list — grows to fill the remaining drawer height */}
          {allComments.length > 0 && (
            <div ref={listRef} className="space-y-1.5 flex-1 min-h-0 overflow-y-auto">
              {allComments.map((comment, i) => {
                const isReso = isResoMessage(comment);
                const draft = isDraft(i);

                return (
                  <div key={i} className={`flex ${isReso ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[75%] px-3 py-1.5 rounded-lg text-xs ${
                      isReso
                        ? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                        : 'bg-blue-100 dark:bg-blue-900/30 text-blue-900 dark:text-blue-200'
                    } ${draft ? 'border border-dashed border-amber-300 dark:border-amber-600' : ''}`}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="font-medium text-[10px]">
                          {isReso ? 'RESO' : userName}
                        </span>
                        <span className="text-[9px] text-gray-400 dark:text-gray-500">
                          {new Date(comment.timestamp).toLocaleString()}
                        </span>
                        {draft && (
                          <button
                            type="button"
                            onClick={() => onRemoveComment(i - existingComments.length)}
                            className="text-red-400 hover:text-red-600 ml-auto"
                            title="Remove draft comment"
                          >
                            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                            </svg>
                          </button>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap break-words">{comment.message}</p>
                      {comment.attachments && comment.attachments.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {comment.attachments.map((att, ai) => (
                            <a
                              key={ai}
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block text-[10px] text-blue-600 dark:text-blue-400 hover:underline truncate"
                            >
                              {att.displayText}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Input */}
          {!isReadOnly && (
            <div className="space-y-1.5">
              {/* Pending attachments */}
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {attachments.map((att, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-[10px] bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                      {att.displayText}
                      <button type="button" onClick={() => handleRemoveAttachment(i)} className="text-blue-400 hover:text-red-500">
                        <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Attachment input */}
              {showAttach && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={attachText}
                    onChange={e => setAttachText(e.target.value)}
                    placeholder="Display text"
                    className="flex-1 px-2 py-1 text-[10px] rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 outline-none"
                  />
                  <input
                    type="url"
                    value={attachUrl}
                    onChange={e => setAttachUrl(e.target.value)}
                    placeholder="https://..."
                    className={`flex-1 px-2 py-1 text-[10px] rounded border ${
                      attachUrl && !attachUrl.startsWith('https://') ? 'border-red-300' : 'border-gray-300 dark:border-gray-600'
                    } bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 outline-none`}
                  />
                  <button
                    type="button"
                    onClick={handleAddAttachment}
                    disabled={!attachUrl.startsWith('https://')}
                    className="px-2 py-1 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAttach(false); setAttachUrl(''); setAttachText(''); }}
                    className="px-2 py-1 text-[10px] text-gray-400 hover:text-gray-600"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Message input */}
              <div className="flex items-end gap-1.5">
                <textarea
                  ref={textareaRef}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="Add a comment..."
                  rows={1}
                  className="flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 resize-none outline-none focus:ring-1 focus:ring-blue-500"
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
                />
                <button
                  type="button"
                  onClick={() => setShowAttach(!showAttach)}
                  className="p-1.5 text-gray-400 hover:text-blue-500 transition-colors"
                  title="Attach link"
                >
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M15.621 4.379a3 3 0 00-4.242 0l-7 7a3 3 0 004.241 4.243h.001l.497-.5a.75.75 0 011.064 1.057l-.498.501-.002.002a4.5 4.5 0 01-6.364-6.364l7-7a4.5 4.5 0 016.368 6.36l-3.455 3.553A2.625 2.625 0 119.52 9.52l3.45-3.451a.75.75 0 111.061 1.06l-3.45 3.451a1.125 1.125 0 001.587 1.595l3.454-3.553a3 3 0 000-4.242z" clipRule="evenodd" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!message.trim()}
                  className="p-1.5 text-blue-600 dark:text-blue-400 hover:text-blue-700 disabled:opacity-30 transition-colors"
                  title="Send"
                >
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
