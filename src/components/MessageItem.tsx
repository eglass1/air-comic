import React, { useState } from 'react';
import {
  Box,
  Typography,
  Avatar,
  Paper,
  Chip,
  Tooltip,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import VerifiedIcon from '@mui/icons-material/Verified';
import { ChatMessage, Participant } from '../types';
import { ContactCardDialog } from './ContactCardDialog';

interface MessageItemProps {
  message: ChatMessage;
}

export const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const [showContactCard, setShowContactCard] = useState<boolean>(false);

  const formattedTime = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  // System Messages
  if (message.isSystem) {
    let chipColor: 'primary' | 'success' | 'warning' | 'error' | 'default' = 'default';

    if (message.systemType === 'claim' || message.systemType === 'rekey') {
      chipColor = 'primary';
    } else if (message.systemType === 'approved' || message.systemType === 'join') {
      chipColor = 'success';
    } else if (message.systemType === 'request' || message.systemType === 'leave') {
      chipColor = 'warning';
    } else if (message.systemType === 'removed' || message.systemType === 'error') {
      chipColor = 'error';
    }

    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', my: 1, px: 2 }}>
        <Chip
          icon={message.systemType === 'claim' || message.systemType === 'rekey' ? <VerifiedIcon sx={{ fontSize: '14px !important' }} /> : undefined}
          label={`${message.text} • ${formattedTime}`}
          size="small"
          variant="outlined"
          color={chipColor}
          sx={{
            bgcolor: 'background.paper',
            borderColor: 'divider',
            fontSize: '0.75rem',
            py: 0.3,
            maxWidth: '90%',
            '& .MuiChip-label': { whiteSpace: 'normal', textOverflow: 'clip' },
          }}
        />
      </Box>
    );
  }

  // Undecryptable Message
  if (!message.decrypted) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'flex-start', my: 1, px: 2 }}>
        <Paper
          variant="outlined"
          sx={{
            p: 1.5,
            bgcolor: 'rgba(255, 82, 82, 0.08)',
            borderColor: 'error.main',
            borderRadius: 2,
            maxWidth: '80%',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <LockIcon color="error" fontSize="small" />
            <Typography variant="caption" color="error.main" sx={{ fontWeight: 700 }}>
              Encrypted Message (Key Epoch Unavailable)
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formattedTime}
            </Typography>
          </Box>
          <Typography variant="body2" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
            {message.text}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', mt: 0.5, fontSize: '0.7rem', color: 'text.secondary' }}>
            Key ID: <code>{message.keyId}</code>
          </Typography>
        </Paper>
      </Box>
    );
  }

  const isSelf = message.isSelf;

  const participantStub: Participant = {
    participantId: message.senderId || 'unknown',
    screenName: message.sender.screenName,
    publicKey: message.sender.publicKey || '',
    signingPublicKey: message.sender.signingPublicKey || '',
    contactInfo: message.sender.contactInfo,
    lastSeen: message.timestamp,
    isSelf,
    status: 'online',
    isApproved: true,
  };

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          justifyContent: isSelf ? 'flex-end' : 'flex-start',
          my: 1,
          px: { xs: 1, sm: 2 },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            flexDirection: isSelf ? 'row-reverse' : 'row',
            alignItems: 'flex-end',
            gap: 1,
            maxWidth: { xs: '88%', sm: '75%' },
          }}
        >
          {!isSelf && (
            <Tooltip title={`View info for ${message.sender.screenName}`}>
              <Avatar
                sx={{
                  bgcolor: 'secondary.main',
                  color: '#ffffff',
                  width: 32,
                  height: 32,
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  mb: 0.5,
                  '&:hover': {
                    transform: 'scale(1.05)',
                  },
                }}
                onClick={() => setShowContactCard(true)}
              >
                {message.sender.screenName.charAt(0).toUpperCase()}
              </Avatar>
            </Tooltip>
          )}

          <Paper
            elevation={isSelf ? 2 : 1}
            sx={{
              p: 1.5,
              borderRadius: 3,
              borderTopRightRadius: isSelf ? 0.5 : 3,
              borderTopLeftRadius: !isSelf ? 0.5 : 3,
              bgcolor: isSelf ? 'primary.main' : 'background.paper',
              color: isSelf ? 'primary.contrastText' : 'text.primary',
              border: '1px solid',
              borderColor: isSelf ? 'primary.dark' : 'divider',
              boxShadow: isSelf
                ? '0 3px 10px rgba(0, 229, 255, 0.25)'
                : '0 2px 6px rgba(0,0,0,0.1)',
            }}
          >
            {/* Sender and epoch badge */}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, mb: 0.5 }}>
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 700,
                  color: isSelf ? 'rgba(0,0,0,0.85)' : 'primary.main',
                  fontSize: '0.78rem',
                  cursor: !isSelf ? 'pointer' : 'default',
                  '&:hover': { textDecoration: !isSelf ? 'underline' : 'none' },
                }}
                onClick={() => !isSelf && setShowContactCard(true)}
              >
                {isSelf ? 'You' : message.sender.screenName}
              </Typography>
            </Box>

            {/* Message text */}
            <Typography
              variant="body1"
              sx={{
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
                fontSize: '0.92rem',
                lineHeight: 1.4,
              }}
            >
              {message.text}
            </Typography>

            {/* Timestamp */}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
              <Typography
                variant="caption"
                sx={{
                  fontSize: '0.65rem',
                  color: isSelf ? 'rgba(0,0,0,0.6)' : 'text.secondary',
                }}
              >
                {formattedTime}
              </Typography>
            </Box>
          </Paper>
        </Box>
      </Box>

      {showContactCard && (
        <ContactCardDialog
          participant={participantStub}
          open={showContactCard}
          onClose={() => setShowContactCard(false)}
        />
      )}
    </>
  );
};
