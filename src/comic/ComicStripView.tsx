import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Box,
  Typography,
  Paper,
  CircularProgress,
  IconButton,
  Tooltip,
  useTheme,
  Button,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { ChatMessage, Participant } from '../types';
import { ComicPanel, AvatarData, BackdropData } from './types';
import { ComicLayoutEngine } from './comicLayout';
import { AvatarManager } from './avatarManager';
import { useChat } from '../context/ChatContext';

interface ComicStripViewProps {
  messages: ChatMessage[];
  roomName: string;
  defaultBackdrop?: string;
  onOpenInvite?: () => void;
}

const ComicPanelItem: React.FC<{
  panel: ComicPanel;
  panelWidth: number;
  panelHeight: number;
  avatarManager: AvatarManager;
  loadedAvatars: Map<string, AvatarData>;
  backdropData: BackdropData | null;
}> = ({
  panel,
  panelWidth,
  panelHeight,
  avatarManager,
  loadedAvatars,
  backdropData,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoveredChar, setHoveredChar] = useState<{
    screenName: string;
    avatarName: string;
    x: number;
    y: number;
  } | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState<boolean>(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fontsReady, setFontsReady] = useState<boolean>(() => {
    return typeof document !== 'undefined' && 'fonts' in document && document.fonts.status === 'loaded';
  });

  useEffect(() => {
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(() => {
        setFontsReady(true);
      });
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // High DPI Canvas backing
    const dpr = window.devicePixelRatio || 2;
    canvas.width = panelWidth * dpr;
    canvas.height = panelHeight * dpr;
    canvas.style.width = `${panelWidth}px`;
    canvas.style.height = `${panelHeight}px`;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, panelWidth, panelHeight);

    // Attach loaded avatar data to panel characters
    panel.characters.forEach((char) => {
      const cleanKey = char.avatarName.toLowerCase().replace(/\.avb$/, '');
      char.avatarData = loadedAvatars.get(cleanKey) || avatarManager.getCachedAvatar(cleanKey) || null;
    });

    ComicLayoutEngine.drawPanelToCanvas(
      ctx,
      panel,
      panelWidth,
      panelHeight,
      avatarManager,
      backdropData?.canvas || null
    );
  }, [panel, panelWidth, panelHeight, loadedAvatars, backdropData, avatarManager, fontsReady]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || panel.isTitlePanel) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = panelWidth / rect.width;
    const scaleY = panelHeight / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    // Hit test characters in panel
    const hitChar = panel.characters.find((c) => {
      const charW = c.width || 80;
      const charH = c.height || 180;
      return mx >= c.x - 10 && mx <= c.x + charW + 10 && my >= c.y && my <= c.y + charH;
    });

    if (hitChar) {
      const posX = (hitChar.x + (hitChar.width || 80) / 2) / scaleX;
      const posY = Math.max(10, hitChar.y / scaleY);

      if (hoveredChar?.screenName !== hitChar.screenName) {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        setTooltipVisible(false);
        setHoveredChar({
          screenName: hitChar.screenName,
          avatarName: hitChar.avatarName,
          x: posX,
          y: posY,
        });

        hoverTimerRef.current = setTimeout(() => {
          setTooltipVisible(true);
        }, 500); // 0.5s hover delay for responsive tooltip
      }
    } else {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      if (hoveredChar) {
        setHoveredChar(null);
        setTooltipVisible(false);
      }
    }
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredChar(null);
    setTooltipVisible(false);
  };

  const handleDownloadPanel = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `aircomic-panel-${panel.panelIndex}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  return (
    <Box
      sx={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        position: 'relative',
        transition: 'transform 0.15s ease-in-out',
        '&:hover': {
          transform: 'translateY(-2px)',
          '& .panel-actions': {
            opacity: 1,
          },
        },
      }}
    >
      <Box
        sx={{
          bgcolor: '#ffffff',
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          display: 'flex',
          lineHeight: 0,
          position: 'relative',
        }}
      >
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{
            cursor: hoveredChar ? 'pointer' : 'default',
          }}
        />

        {/* Floating Character Hover Tooltip */}
        {hoveredChar && tooltipVisible && (
          <Box
            sx={{
              position: 'absolute',
              left: hoveredChar.x,
              top: hoveredChar.y,
              transform: 'translate(-50%, -100%) translateY(-8px)',
              pointerEvents: 'none',
              zIndex: 20,
              bgcolor: 'rgba(18, 22, 30, 0.94)',
              backdropFilter: 'blur(6px)',
              color: '#ffffff',
              px: 1.2,
              py: 0.5,
              borderRadius: 1.5,
              border: '1px solid rgba(255,255,255,0.15)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 0.2,
              animation: 'tooltipPop 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
              '@keyframes tooltipPop': {
                from: { opacity: 0, transform: 'translate(-50%, -90%) translateY(-4px) scale(0.92)' },
                to: { opacity: 1, transform: 'translate(-50%, -100%) translateY(-8px) scale(1)' },
              },
            }}
          >
            <Typography variant="body2" sx={{ fontWeight: 800, fontSize: '0.82rem', lineHeight: 1.2 }}>
              {hoveredChar.screenName}
            </Typography>
            <Typography variant="caption" sx={{ color: '#90caf9', fontSize: '0.7rem', lineHeight: 1 }}>
              Avatar: {hoveredChar.avatarName}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Panel Action Toolbar */}
      <Box
        className="panel-actions"
        sx={{
          position: 'absolute',
          top: 6,
          right: 6,
          display: 'flex',
          gap: 0.5,
          opacity: 0,
          transition: 'opacity 0.2s ease',
          bgcolor: 'rgba(255,255,255,0.92)',
          borderRadius: 1,
          p: 0.3,
          boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
        }}
      >
        <Tooltip title="Save Panel Image">
          <IconButton size="small" onClick={handleDownloadPanel}>
            <DownloadIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};

export const ComicStripView: React.FC<ComicStripViewProps> = ({
  messages,
  roomName,
  defaultBackdrop = 'room.bgb',
  onOpenInvite,
}) => {
  const theme = useTheme();
  const { profile, participants, zoomLevel } = useChat();
  const avatarManager = useMemo(() => AvatarManager.getInstance(), []);
  const [loadedAvatars, setLoadedAvatars] = useState<Map<string, AvatarData>>(new Map());
  const [backdropData, setBackdropData] = useState<BackdropData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const baseWidth = 400;
  const baseHeight = 425; // Scaled vertically to 125% (400x425 near-square aspect ratio)

  const panelWidth = Math.round(baseWidth * zoomLevel);
  const panelHeight = Math.round(baseHeight * zoomLevel);

  // Pick 3 random distinct avatars for this room's title page (Earl excluded)
  const titleAvatars = useMemo(() => {
    return ComicLayoutEngine.getRandomTitleAvatars();
  }, [roomName]);

  // Generate Panels
  const panels = useMemo(() => {
    return ComicLayoutEngine.generatePanels(messages, {
      panelWidth,
      panelHeight,
      defaultBackdrop,
      roomName,
      titleAvatars,
      profile,
      participants,
    });
  }, [messages, panelWidth, panelHeight, defaultBackdrop, roomName, titleAvatars, profile, participants]);

  // Pre-load Backdrop
  useEffect(() => {
    let isMounted = true;
    avatarManager.loadBackdrop(defaultBackdrop).then((data) => {
      if (isMounted) {
        setBackdropData(data);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [defaultBackdrop, avatarManager]);

  // Pre-load all avatars referenced in the message stream and participants
  useEffect(() => {
    let isMounted = true;
    const avatarNames = new Set<string>();

    // Title page showcase avatars
    titleAvatars.forEach((name) => avatarNames.add(name.toLowerCase()));

    if (profile?.avatarName) {
      avatarNames.add(profile.avatarName.toLowerCase().replace(/\.avb$/, ''));
    }

    participants?.forEach((p: Participant) => {
      if (p.avatarName) {
        avatarNames.add(p.avatarName.toLowerCase().replace(/\.avb$/, ''));
      }
    });

    messages.forEach((msg) => {
      if (msg.sender?.avatarName) {
        avatarNames.add(msg.sender.avatarName.toLowerCase().replace(/\.avb$/, ''));
      }
    });

    const namesList = Array.from(avatarNames);
    const loadPromises = namesList.map((name) =>
      avatarManager.loadAvatar(name)
    );

    Promise.all(loadPromises).then((results) => {
      if (!isMounted) return;
      const map = new Map<string, AvatarData>();
      results.forEach((av, idx) => {
        if (av) {
          const reqName = namesList[idx];
          if (reqName) {
            map.set(reqName, av);
            map.set(reqName.toLowerCase(), av);
            map.set(`${reqName.toLowerCase()}.avb`, av);
          }
          map.set(av.name.toLowerCase(), av);
          const found = AvatarManager.AVAILABLE_AVATARS.find(
            (a) => a.name.toLowerCase() === av.name.toLowerCase() || a.id === av.name.toLowerCase()
          );
          if (found) {
            map.set(found.id.toLowerCase(), av);
            map.set(found.name.toLowerCase(), av);
          }
        }
      });
      setLoadedAvatars(map);
      setLoading(false);
    });

    return () => {
      isMounted = false;
    };
  }, [messages, avatarManager, profile?.avatarName, participants]);

  // Auto-scroll to bottom on new messages / panels
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [panels.length]);

  return (
    <Box
      ref={scrollContainerRef}
      sx={{
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        p: { xs: 1, sm: 2 },
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        bgcolor: theme.palette.mode === 'dark' ? '#12161c' : '#f0efe9',
        backgroundImage:
          theme.palette.mode === 'dark'
            ? 'radial-gradient(#1e2430 1px, transparent 1px)'
            : 'radial-gradient(#dedbd2 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
    >
      {/* Panels Stream Grid */}
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: 1,
          maxWidth: '100%',
        }}
      >
        {panels.map((panel) => (
          <ComicPanelItem
            key={panel.id}
            panel={panel}
            panelWidth={panelWidth}
            panelHeight={panelHeight}
            avatarManager={avatarManager}
            loadedAvatars={loadedAvatars}
            backdropData={backdropData}
          />
        ))}
      </Box>

      <div ref={bottomRef} style={{ height: 20 }} />
    </Box>
  );
};
