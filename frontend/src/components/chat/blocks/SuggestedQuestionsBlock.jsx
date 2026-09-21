/**
 * SuggestedQuestionsBlock - placed BELOW everything else in the message
 * (see ChatMessageBubble) per the brief. Every question is a fixed,
 * deterministic string the backend template-generated (see
 * backend/services/responseBlocks.js's SUGGESTED_QUESTION_TEMPLATES) —
 * this component only renders plain text buttons; it never generates or
 * alters the question text.
 *
 * `onAsk` is optional: without it (e.g. in a context with no composer
 * wired up) the questions still render as informational chips.
 */
export const isValidSuggestedQuestionsBlock = (block) => Boolean(
  block && block.type === 'suggested_questions' && Array.isArray(block.questions) && block.questions.length > 0,
);

export default function SuggestedQuestionsBlock({ block, onAsk }) {
  if (!isValidSuggestedQuestionsBlock(block)) return null;

  return (
    <div className="mt-3 pt-3 border-t border-dashed border-gs-border" data-testid="block-suggested-questions">
      <div className="gs-label mb-1.5">Suggested follow-ups</div>
      <div className="flex flex-wrap gap-1.5">
        {block.questions.map((question, index) => (
          <button
            key={`${index}-${question}`}
            type="button"
            onClick={onAsk ? () => onAsk(question) : undefined}
            disabled={!onAsk}
            className="text-left text-[11.5px] px-2.5 py-1.5 rounded-sm border border-gs-border bg-gs-panel text-gs-textMuted hover:border-gs-gold/40 hover:text-gs-text disabled:cursor-default disabled:hover:border-gs-border disabled:hover:text-gs-textMuted"
            data-testid="suggested-question"
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  );
}
