import type { ReactNode } from 'react';
import './controlNoticeBar.css';
/** Current actionable state only. Historical details belong to Terminal. */
export function ControlNoticeBar({messages,children}:{messages:readonly (string|null|undefined|false)[];children?:ReactNode}) {
 const items=[...new Set(messages.filter((value):value is string=>typeof value==='string'&&Boolean(value)))];
 if(!items.length)return null;
 return <aside className="control-notice-bar" aria-label="控制提示" role="status"><div>{items.map(message=><p key={message}>{message}</p>)}</div>{children}</aside>;
}
