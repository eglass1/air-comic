import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  TextField,
  IconButton,
  Typography,
  Tooltip,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import { useChat } from '../context/ChatContext';
import { EmotionWheel } from '../comic/EmotionWheel';
import { EM_NEUTRAL } from '../comic/types';
import { COMIC_FONT_FAMILY } from '../comic/comicLayout';

export const QuickMessageDialog: React.FC = () => {
  const {
    profile,
    quickMessageTarget,
    closeQuickMessage,
    sendQuickMessage,
  } = useChat();

  const [text, setText] = useState('');
  const [emotion, setEmotion] = useState<number>(EM_NEUTRAL);
  const [intensity, setIntensity] = useState<number>(0.0);
  const [isSending, setIsSending] = useState(false);

  // Reset state when dialog opens or target changes
  useEffect(() => {
    if (quickMessageTarget) {
      setText('');
      setEmotion(EM_NEUTRAL);
      setIntensity(0.0);
      setIsSending(false);
    }
  }, [quickMessageTarget]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    setIsSending(true);
    try {
      await sendQuickMessage(trimmed, emotion, intensity);
      closeQuickMessage();
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const maxChars = 150;
  const charsRemaining = maxChars - text.length;

  return (
    <Dialog
      open={Boolean(quickMessageTarget)}
      onClose={closeQuickMessage}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 2,
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.28)',
        },
      }}
    >
      <DialogTitle
        sx={{
          m: 0,
          p: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <ChatBubbleOutlineIcon color="primary" fontSize="small" />
          <Typography
            variant="subtitle1"
            sx={{
              fontWeight: 700,
              fontFamily: COMIC_FONT_FAMILY,
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Quick Message to {quickMessageTarget?.screenName}
          </Typography>
        </Box>
        <IconButton
          aria-label="close"
          onClick={closeQuickMessage}
          size="small"
          sx={{
            color: 'text.secondary',
            '&:hover': { color: 'text.primary' },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ p: 0, bgcolor: 'background.paper' }}>
        {/* Emotion Wheel Widget */}
        <Box sx={{ pt: 1, pb: 0.5 }}>
          <EmotionWheel
            avatarName={profile?.avatarName || 'Armando'}
            selectedEmotion={emotion}
            selectedIntensity={intensity}
            onChangeEmotion={(newEmotion, newIntensity) => {
              setEmotion(newEmotion);
              setIntensity(newIntensity);
            }}
          />
        </Box>

        {/* Text Entry Box with Countdown & Send Arrow */}
        <Box
          sx={{
            p: 1.5,
            pt: 1,
            borderTop: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.default',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
              value={text}
              onChange={(e) => {
                if (e.target.value.length <= maxChars) {
                  setText(e.target.value);
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${quickMessageTarget?.screenName || ''}...`}
              size="small"
              fullWidth
              autoFocus
              inputProps={{ maxLength: maxChars }}
              multiline
              maxRows={3}
              sx={{
                '& .MuiInputBase-root': {
                  fontSize: '0.875rem',
                },
              }}
            />
            <Tooltip title="Send Quick Message">
              <span>
                <IconButton
                  color="primary"
                  onClick={handleSend}
                  disabled={!text.trim() || isSending}
                  sx={{
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    '&:hover': { bgcolor: 'primary.dark' },
                    '&.Mui-disabled': {
                      bgcolor: 'action.disabledBackground',
                      color: 'action.disabled',
                    },
                    p: 1,
                  }}
                >
                  <SendIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'flex-end',
              mt: 0.5,
              px: 0.5,
            }}
          >
            <Typography
              variant="caption"
              sx={{
                fontSize: '0.72rem',
                fontWeight: 600,
                color: charsRemaining < 20 ? 'warning.main' : 'text.secondary',
              }}
            >
              {charsRemaining} left
            </Typography>
          </Box>
        </Box>
      </DialogContent>
    </Dialog>
  );
};
