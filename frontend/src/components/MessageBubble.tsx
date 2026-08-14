import { colors } from '../theme';
import { Message } from '../types';

interface Props {
  message: Message;
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  return (
    <div style={{ ...styles.row, justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      {!isUser && <span style={styles.botAvatar}>🤖</span>}
      <div style={isUser ? styles.userBubble : styles.assistantBubble}>
        <p style={styles.text}>{message.content}</p>
        <span style={{ ...styles.time, textAlign: isUser ? 'right' : 'left' }}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 12,
  },
  botAvatar: {
    fontSize: '1.1rem',
    flexShrink: 0,
    marginBottom: 2,
  },
  userBubble: {
    maxWidth: '68%',
    padding: '0.65rem 1rem',
    borderRadius: '16px 16px 4px 16px',
    background: colors.green.primary,
    color: colors.white,
    wordBreak: 'break-word',
  },
  assistantBubble: {
    maxWidth: '68%',
    padding: '0.65rem 1rem',
    borderRadius: '16px 16px 16px 4px',
    background: colors.white,
    color: colors.text.primary,
    border: `1px solid ${colors.gray[200]}`,
    wordBreak: 'break-word',
  },
  text: { fontSize: '0.93rem', lineHeight: 1.55, whiteSpace: 'pre-wrap' },
  time: {
    display: 'block',
    fontSize: '0.68rem',
    opacity: 0.6,
    marginTop: 4,
  },
};
