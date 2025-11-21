// src/pipelines/news/types.ts
export type SourceSide = 'left' | 'center' | 'right' | 'neutral';

export type RawArticleLite = {
  url: string;
  title: string;
  outlet: string;
  side: SourceSide;
  publishedAt?: Date;
  summary?: string;
  // 선택적으로 들어올 수 있는 임시 키들(있어도 되고 없어도 됨)
  body?: string;
  hash?: string;
  clusterKey?: string;
};

export type Cluster = {
  key: string;
  /** 반드시 articles 로 맞춥니다 (attachIssues와 합치기) */
  articles: RawArticleLite[];
  title?: string;
  summary?: string;
  tags?: string[];
};
