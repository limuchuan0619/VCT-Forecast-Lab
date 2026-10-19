import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from '@/components/ui/pagination';

export function HistoryPagination({
  page,
  pages,
  base,
}: {
  page: number;
  pages: number;
  base: string;
}) {
  if (pages < 2) return null;
  return (
    <Pagination className="history-pagination" aria-label="历史记录翻页">
      <PaginationContent>
        {page > 1 && (
          <PaginationItem>
            <PaginationLink size="default" href={`${base}?page=${page - 1}`}>
              上一页
            </PaginationLink>
          </PaginationItem>
        )}
        <PaginationItem>
          <span aria-current="page">
            第 {page} / {pages} 页
          </span>
        </PaginationItem>
        {page < pages && (
          <PaginationItem>
            <PaginationLink size="default" href={`${base}?page=${page + 1}`}>
              下一页
            </PaginationLink>
          </PaginationItem>
        )}
      </PaginationContent>
    </Pagination>
  );
}
