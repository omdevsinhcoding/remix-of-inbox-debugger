ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS sort_order integer,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS notifications_touch_updated_at ON public.notifications;
CREATE TRIGGER notifications_touch_updated_at
BEFORE UPDATE ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS notifications_sort_order_idx ON public.notifications (sort_order NULLS LAST, created_at DESC);