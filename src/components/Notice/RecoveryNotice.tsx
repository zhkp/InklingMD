// 非阻塞提示条（role="status"）：
// 草稿超限这类「恢复副本降级」只影响某一份副本，不能弹模态打断用户输入。
// 范式与 Editor 的链接跟随提示一致：浮在底部、4s 自动消失、不抢焦点。

import { useEffect } from "react";
import { useUI } from "../../store/ui";
import "./RecoveryNotice.css";

const AUTO_DISMISS_MS = 4_000;

export function RecoveryNotice() {
  const notice = useUI((s) => s.notice);
  const dismissNotice = useUI((s) => s.dismissNotice);

  useEffect(() => {
    if (!notice) return;
    // 只关自己这条：期间若来了新提示，id 不匹配时 dismissNotice 会忽略
    const { id } = notice;
    const timer = window.setTimeout(() => dismissNotice(id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice, dismissNotice]);

  if (!notice) return null;
  return (
    <div className="recovery-notice" role="status">
      {notice.text}
    </div>
  );
}

export default RecoveryNotice;
