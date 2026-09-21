import { useState } from "react";
import { ImageOff } from "lucide-react";
import { isSafeBlockUrl } from "./blockHelpers";
import CitationMarker from "./CitationMarker";

/**
 * NewsListBlock - up to 5 real, cited news cards. Headline/publisher/date/
 * link mirror src/pages/News.jsx's existing NewsCard patterns exactly
 * (same "Date unavailable" honesty rule, same image-failure fallback) —
 * this is that same pattern applied inside a chat message rather than the
 * full News page.
 *
 * No summary/description is shown at all (see backend's NewsArticleSchema
 * — the block never carries one): the headline is the real article's own
 * title, verbatim, never a generated or paraphrased summary.
 */
const formatIstDate = (iso) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });
};

export const isValidNewsListBlock = (block) => Boolean(
  block && block.type === 'news_list' && Array.isArray(block.articles) && block.articles.length > 0
  && block.articles.every((a) => a?.evidenceId && a?.title && a?.url && isSafeBlockUrl(a.url)),
);

const NewsCard = ({ article, onOpenEvidence }) => {
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = article.imageUrl && isSafeBlockUrl(article.imageUrl) && !imageFailed;
  const dateLabel = formatIstDate(article.publishedAt) || 'Date unavailable';

  const openArticle = () => window.open(article.url, '_blank', 'noopener,noreferrer');

  return (
    <article
      className="rounded-sm border border-gs-border bg-gs-panel/60 overflow-hidden hover:bg-gs-panel transition-colors cursor-pointer"
      onClick={openArticle}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openArticle(); } }}
      role="link"
      tabIndex={0}
      data-testid="news-card"
    >
      <div className="h-24 bg-gs-bg/60">
        {hasImage ? (
          <img
            src={article.imageUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="h-full grid place-items-center gap-1 text-[9px] uppercase tracking-wider text-gs-textDim" data-testid="news-card-no-image">
            <ImageOff className="w-3.5 h-3.5" />
          </div>
        )}
      </div>
      <div className="p-2">
        <h4 className="font-display font-bold text-gs-text text-[11.5px] leading-snug line-clamp-2">
          {article.title}
          {/* The card's own onClick opens the article; without stopping
              propagation here, clicking [N] would ALSO trigger that --
              opening the evidence drawer must not also navigate away. */}
          <span onClick={(event) => event.stopPropagation()}>
            <CitationMarker citationIndex={article.citationIndex} evidenceId={article.evidenceId} onOpenEvidence={onOpenEvidence} />
          </span>
        </h4>
        <div className="flex items-center justify-between mt-1.5 text-[9.5px] font-mono uppercase tracking-wider text-gs-textDim">
          <span className="truncate">{article.publisher || 'Unknown source'}</span>
          <span className="shrink-0 ml-1.5">{dateLabel}</span>
        </div>
      </div>
    </article>
  );
};

export default function NewsListBlock({ block, onOpenEvidence }) {
  if (!isValidNewsListBlock(block)) return null;

  return (
    <div className="my-2" data-testid="block-news-list">
      <div className="gs-label mb-2">Related news</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {block.articles.map((article, index) => (
          <NewsCard key={article.evidenceId || index} article={article} onOpenEvidence={onOpenEvidence} />
        ))}
      </div>
    </div>
  );
}
