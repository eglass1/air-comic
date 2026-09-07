import React, { useState, useEffect } from 'react';
import {
  Box,
  TextField,
  IconButton,
  Typography,
  Paper,
  Chip,
  Button,
  Alert,
  CircularProgress,
  Tooltip,
  ToggleButtonGroup,
  ToggleButton,
  Collapse,
} from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import SendIcon from '@mui/icons-material/Send';
import SecurityIcon from '@mui/icons-material/Security';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import EmojiEmotionsIcon from '@mui/icons-material/EmojiEmotions';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import PsychologyIcon from '@mui/icons-material/Psychology';
import VolumeDownIcon from '@mui/icons-material/VolumeDown';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { useChat } from '../context/ChatContext';
import { ComicStripView } from '../comic/ComicStripView';
import { EmotionWheel } from '../comic/EmotionWheel';
import { EM_NEUTRAL, BalloonMode } from '../comic/types';
import { EmotionEngine } from '../comic/emotionEngine';

interface ChatAreaProps {
  onOpenInvite: () => void;
  onOpenSecurity: () => void;
  onOpenRequests: () => void;
  onOpenPublicRooms?: () => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  onOpenInvite,
  onOpenSecurity,
  onOpenRequests,
  onOpenPublicRooms,
}) => {
  const {
    messages,
    sendMessage,
    convId,
    isFavoriteRoom,
    toggleFavoriteRoom,
    profile,
    activeEpoch,
    isApproved,
    connectionStatus,
    pendingJoinRequests,
    approveJoinRequest,
    declineJoinRequest,
    sendJoinRequest,
    isRekeying,
    connectedPeersCount,
    channelTitle,
    updateChannelTitle,
    canRenameRoom,
    roomMode,
  } = useChat();

  const [inputText, setInputText] = useState<string>('');
  const [showEmotionWheel, setShowEmotionWheel] = useState<boolean>(false);
  const [balloonMode, setBalloonMode] = useState<BalloonMode>('say');
  const [selectedEmotion, setSelectedEmotion] = useState<number>(EM_NEUTRAL);
  const [selectedIntensity, setSelectedIntensity] = useState<number>(0.0);
  const [approvingReqId, setApprovingReqId] = useState<string | null>(null);

  const [isEditingTitle, setIsEditingTitle] = useState<boolean>(false);
  const [titleInput, setTitleInput] = useState<string>(channelTitle);

  useEffect(() => {
    setTitleInput(channelTitle);
  }, [channelTitle]);

  useEffect(() => {
    if (!canRenameRoom) setIsEditingTitle(false);
  }, [canRenameRoom]);

  const handleSaveTitle = async () => {
    const trimmed = titleInput.trim();
    if (trimmed && trimmed !== channelTitle) {
      await updateChannelTitle(trimmed);
    }
    setIsEditingTitle(false);
  };

  const handleSend = async () => {
    if (!inputText.trim()) return;
    const textToSend = inputText;
    setInputText('');

    // If manual emotion was selected, pass it, otherwise let engine detect from text
    const detected = EmotionEngine.detectEmotionFromText(textToSend);
    const effEmotion = selectedIntensity > 0 ? selectedEmotion : detected.emotion;
    const effIntensity = selectedIntensity > 0 ? selectedIntensity : detected.intensity;
    const effBalloonMode = balloonMode !== 'say' ? balloonMode : detected.balloonMode;

    await sendMessage(textToSend, {
      emotion: effEmotion,
      emotionIntensity: effIntensity,
      balloonMode: effBalloonMode,
    });

    // Reset manual emotion back to neutral after sending
    if (selectedIntensity > 0) {
      setSelectedEmotion(EM_NEUTRAL);
      setSelectedIntensity(0.0);
    }

    // Close Emotion Wheel on send
    setShowEmotionWheel(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuickApprove = async () => {
    if (pendingJoinRequests.length === 0) return;
    const req = pendingJoinRequests[0];
    setApprovingReqId(req.requestId);
    await approveJoinRequest(req);
    setApprovingReqId(null);
  };

  const handleQuickDecline = () => {
    if (pendingJoinRequests.length === 0) return;
    declineJoinRequest(pendingJoinRequests[0].requestId);
  };

  const currentAvatarName = profile?.avatarName || 'Armando';
  const currentBackdropName = profile?.backdropName || 'room.bgb';

  return (
    <Box
      sx={{
        flexGrow: 1,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Room Header Bar */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          px: 2,
          py: 0.8,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
          position: 'relative',
        }}
      >
        {/* Left balance spacer */}
        <Box sx={{ width: { xs: 0, sm: 40 }, flexShrink: 0 }} />

        {/* Centered Channel Title Widget */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexGrow: 1 }}>
          {isEditingTitle ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <TextField
                size="small"
                variant="outlined"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveTitle();
                  if (e.key === 'Escape') setIsEditingTitle(false);
                }}
                autoFocus
                placeholder="Channel Title..."
                sx={{
                  '& .MuiInputBase-input': {
                    py: 0.3,
                    px: 1,
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    textAlign: 'center',
                  },
                  width: { xs: 150, sm: 220 },
                }}
              />
              <IconButton size="small" color="primary" onClick={handleSaveTitle}>
                <CheckIcon fontSize="small" />
              </IconButton>
              <IconButton size="small" onClick={() => setIsEditingTitle(false)}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ) : (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                cursor: canRenameRoom ? 'pointer' : 'default',
                p: 0.3,
                borderRadius: 1,
                ...(canRenameRoom ? { '&:hover': { bgcolor: 'action.hover' } } : {}),
              }}
              onClick={
                canRenameRoom
                  ? () => {
                      setTitleInput(channelTitle);
                      setIsEditingTitle(true);
                    }
                  : undefined
              }
            >
              <Typography variant="body2" sx={{ fontWeight: 800, color: 'text.primary' }}>
                {channelTitle}
              </Typography>
              {/* A public room is renamed by whoever created it, and nobody
                  else, so there is no pencil to offer the rest [PU-02]. */}
              {canRenameRoom && (
                <Tooltip title="Edit Channel Title">
                  <EditIcon sx={{ fontSize: 15, color: 'text.secondary', opacity: 0.7 }} />
                </Tooltip>
              )}
            </Box>
          )}
        </Box>

        {/* Right Actions */}
        <Box
          sx={{
            width: { xs: 'auto', sm: 40 },
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 0.5,
            flexShrink: 0,
          }}
        >
          <Tooltip title={isFavoriteRoom ? 'Remove from Favorite Rooms' : 'Save to Favorite Rooms'}>
            <span>
              <IconButton
                size="small"
                onClick={() => { void toggleFavoriteRoom(); }}
                disabled={!convId}
                aria-label={isFavoriteRoom ? 'Remove from favorites' : 'Add to favorites'}
                sx={{ color: isFavoriteRoom ? 'error.main' : 'action.disabled' }}
              >
                {isFavoriteRoom ? (
                  <FavoriteIcon sx={{ fontSize: 19 }} />
                ) : (
                  <FavoriteBorderIcon sx={{ fontSize: 19 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {/* Prominent Pending Entry Requests Notification Banner for Approved Members (Private Rooms) */}
      {roomMode !== 'public' && isApproved && pendingJoinRequests.length > 0 && (
        <Alert
          severity="warning"
          icon={<NotificationsActiveIcon />}
          action={
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Button
                color="inherit"
                size="small"
                variant="outlined"
                startIcon={<CancelIcon />}
                onClick={handleQuickDecline}
                disabled={isRekeying}
              >
                Decline
              </Button>
              <Button
                color="primary"
                size="small"
                variant="contained"
                startIcon={approvingReqId ? <CircularProgress size={14} color="inherit" /> : <CheckCircleIcon />}
                onClick={handleQuickApprove}
                disabled={isRekeying}
              >
                Approve & Add to Contacts
              </Button>
              {pendingJoinRequests.length > 1 && (
                <Button color="inherit" size="small" onClick={onOpenRequests}>
                  All ({pendingJoinRequests.length})
                </Button>
              )}
            </Box>
          }
          sx={{
            borderRadius: 0,
            py: 1,
            px: 3,
            borderBottom: '1px solid',
            borderColor: 'warning.main',
            alignItems: 'center',
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Entry Request: <strong>{pendingJoinRequests[0].sender.screenName}</strong>
            {pendingJoinRequests[0].sender.contactInfo?.info ? ` ("${pendingJoinRequests[0].sender.contactInfo.info.slice(0, 30)}...")` : ''} wants to join.
          </Typography>
        </Alert>
      )}

      {/* Main Conversation Area: Comic Strip View */}
      <ComicStripView
        messages={messages}
        roomName={channelTitle}
        defaultBackdrop={currentBackdropName}
        onOpenInvite={onOpenInvite}
      />

      {/* Message Input Box or Guest Pending Card */}
      <Paper
        square
        elevation={4}
        sx={{
          p: { xs: 1, sm: 1.5 },
          // Keep the composer clear of the home indicator / gesture bar while
          // letting the paper surface itself run to the bottom edge.
          pb: { xs: 'calc(8px + env(safe-area-inset-bottom))', sm: 'calc(12px + env(safe-area-inset-bottom))' },
          bgcolor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          position: 'relative',
        }}
      >
        {isApproved ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {/* Balloon Mode and Emotion Toggle Controls */}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 0.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <ToggleButtonGroup
                  value={balloonMode}
                  exclusive
                  onChange={(_, newMode) => {
                    if (newMode) setBalloonMode(newMode);
                  }}
                  size="small"
                  sx={{ height: 26 }}
                >
                  <ToggleButton value="say" sx={{ px: 1, py: 0, fontSize: '0.72rem', fontWeight: 700 }}>
                    <RecordVoiceOverIcon sx={{ fontSize: 13, mr: 0.4 }} /> Say
                  </ToggleButton>
                  <ToggleButton value="whisper" sx={{ px: 1, py: 0, fontSize: '0.72rem', fontWeight: 700 }}>
                    <VolumeDownIcon sx={{ fontSize: 13, mr: 0.4 }} /> Whisper
                  </ToggleButton>
                  <ToggleButton value="think" sx={{ px: 1, py: 0, fontSize: '0.72rem', fontWeight: 700 }}>
                    <PsychologyIcon sx={{ fontSize: 13, mr: 0.4 }} /> Think
                  </ToggleButton>
                  <ToggleButton value="action" sx={{ px: 1, py: 0, fontSize: '0.72rem', fontWeight: 700 }}>
                    <FlashOnIcon sx={{ fontSize: 13, mr: 0.4 }} /> Action
                  </ToggleButton>
                </ToggleButtonGroup>
              </Box>

              {/* Emotion Wheel Trigger Button (Purple Smiley Bubble) */}
              <Tooltip title={showEmotionWheel ? 'Hide Emotion Wheel' : selectedIntensity > 0 ? 'Emotion Wheel (Active)' : 'Emotion Wheel'}>
                <IconButton
                  size="small"
                  color="secondary"
                  onClick={() => setShowEmotionWheel((prev) => !prev)}
                  sx={{
                    width: 28,
                    height: 28,
                    bgcolor: showEmotionWheel
                      ? 'secondary.main'
                      : selectedIntensity > 0
                      ? 'rgba(156, 39, 176, 0.16)'
                      : 'rgba(156, 39, 176, 0.08)',
                    color: showEmotionWheel ? 'secondary.contrastText' : 'secondary.main',
                    border: '1px solid',
                    borderColor: showEmotionWheel ? 'secondary.main' : 'rgba(156, 39, 176, 0.3)',
                    '&:hover': {
                      bgcolor: showEmotionWheel ? 'secondary.dark' : 'rgba(156, 39, 176, 0.2)',
                    },
                  }}
                >
                  <EmojiEmotionsIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>

              {/* Persistent Floating Emotion Wheel Popup (Stays open while typing, closes on toggle or send) */}
              {showEmotionWheel && (
                <Paper
                  elevation={8}
                  sx={{
                    position: 'absolute',
                    bottom: 'calc(100% + 8px)',
                    right: 16,
                    zIndex: 1200,
                    borderRadius: 3,
                    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                    bgcolor: 'background.paper',
                    border: '1px solid',
                    borderColor: 'divider',
                    overflow: 'hidden',
                  }}
                >
                  <EmotionWheel
                    avatarName={currentAvatarName}
                    selectedEmotion={selectedEmotion}
                    selectedIntensity={selectedIntensity}
                    onChangeEmotion={(emo, inten) => {
                      setSelectedEmotion(emo);
                      setSelectedIntensity(inten);
                    }}
                  />
                </Paper>
              )}
            </Box>

            {/* Input Text Field & Send Button */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TextField
                placeholder={
                  balloonMode === 'say'
                    ? 'Say something in the comic strip...'
                    : balloonMode === 'whisper'
                    ? 'Whisper a message...'
                    : balloonMode === 'think'
                    ? 'Think a thought in a thought balloon...'
                    : 'Perform an action (e.g. waves happily)...'
                }
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                multiline
                maxRows={3}
                fullWidth
                size="small"
                slotProps={{
                  input: {
                    sx: {
                      borderRadius: 2.5,
                      bgcolor: 'background.default',
                    },
                  },
                }}
              />

              <IconButton
                color="primary"
                onClick={handleSend}
                disabled={!inputText.trim()}
                sx={{
                  bgcolor: inputText.trim() ? 'primary.main' : 'action.disabledBackground',
                  color: inputText.trim() ? 'primary.contrastText' : 'action.disabled',
                  '&:hover': {
                    bgcolor: 'primary.dark',
                  },
                  width: 40,
                  height: 40,
                }}
              >
                <SendIcon fontSize="small" />
              </IconButton>
            </Box>
          </Box>
        ) : (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              p: 1.8,
              bgcolor: 'background.default',
              borderRadius: 2,
              border: '1px solid',
              borderColor: 'warning.main',
              flexWrap: 'wrap',
              gap: 1.5,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <HourglassTopIcon color="warning" sx={{ fontSize: 28 }} />
              <Box>
                <Typography variant="subtitle2" color="warning.main" sx={{ fontWeight: 700 }}>
                  Entry Request Sent & Pending Approval
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Waiting for a member to accept your request and send you the
                  current epoch key...
                </Typography>
              </Box>
            </Box>

            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={sendJoinRequest}
            >
              Re-send Entry Request
            </Button>
          </Box>
        )}
      </Paper>
    </Box>
  );
};
