/*
 * Skin replacement for src/components/LeftSidebar.tsx.
 *
 * Same component, same shell semantics: 300px-wide sticky aside,
 * desktop only (hidden on mobile via `hidden sidebar:flex`). All
 * upstream behavior preserved 1:1 — NIP-38 status editor, account
 * switcher popover, sortable sidebar nav, login + share-QR dialogs,
 * unread-notifications indicator, scroll-to-top on active-link click.
 * Every state hook, callback, and ref is a straight port from
 * upstream at DITTO_REF v2.21.0.
 *
 * Visual diff (the entire point of this replacement):
 *
 *  - Logo wrapper: drop `bg-background/85 rounded-full` div — the
 *    skin DittoLogo renders nori.svg in real color as a plain <img>;
 *    the pill container hid its colors against the rail's surface
 *    tone and added Ditto-ish "logo on a pill" aesthetic. Link
 *    directly wraps the logo now.
 *
 *  - Search: kept the upstream ProfileSearchDropdown; the CSS overlay
 *    in src/web/ditto-overrides.css squares its pill + fixes
 *    horizontal padding. (Search is a candidate for a future skin
 *    replacement — left as-is now to keep this phase focused on the
 *    shell chrome.)
 *
 *  - Nav rail: an uppercase section header above the nav list adds
 *    station-style structure (matches the dashboard's NAVIGATION /
 *    OPERATIONS / INFRASTRUCTURE / STATUS section labels at
 *    src/web/app.css:381+). Sets the rail apart from "sidebar of
 *    pills" as the dominant pattern.
 *
 *  - Join button (logged-out CTA): square (rounded-sm) and slightly
 *    tighter h-9.
 *
 *  - Account button (the user-menu trigger): drop rounded-full +
 *    bg-background/85 (the pill that read as "Ditto-style chat-app
 *    user chip"). Just an inline-flex row with hover bg and a
 *    rounded-sm hover state.
 *
 *  - Popover: shadcn's PopoverContent picks up our overlay's
 *    rounded-* + shadow rules; we use `shadow-lg` instead of
 *    `shadow-xl` for a tighter elevation that matches the dashboard's
 *    `--shadow-md` rather than the heavier modal shadow. Border-radius
 *    is forced to --r-lg (8px) via the overlay's rounded-2xl rule.
 *
 *  - Buttons inside the popover (status editor, account switcher,
 *    action items): kept upstream's tight padding — these already
 *    read as dashboard-style. Replaced one `font-bold` (current-user
 *    name in the popover header) with `font-semibold` to match the
 *    dashboard's heading weight convention.
 *
 *  - "Set a status" / NIP-38 status row: small visual tweak — the
 *    italic muted-foreground style stays, but the `Set a status`
 *    placeholder gets `text-xs uppercase tracking-wide` so it reads
 *    like a dashboard-style affordance instead of a chat-app prompt.
 */

import { useState, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  UserPlus, LogOut, Loader2, QrCode,
} from 'lucide-react';
import {
  cn,
  Skeleton,
  Avatar, AvatarImage, AvatarFallback,
  Popover, PopoverContent, PopoverTrigger,
  Input,
  DittoLogo,
  EmojifiedText,
  ProfileSearchDropdown,
  SidebarNavList,
  SidebarMoreMenu,
  LoginDialog,
  FollowQRDialog,
  VerifiedNip05Text,
  useOnboarding,
  useCurrentUser,
  useLoggedInAccounts,
  useLoginActions,
  useFeedSettings,
  useAppContext,
  useHasUnreadNotifications,
  useProfileUrl,
  useUserStatus,
  usePublishStatus,
  useToast,
  isItemActive,
  getAvatarShape,
  genUserName,
  type Account,
} from '@/skin/adapter';

export function LeftSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, metadata, event: currentUserEvent, isLoading: isProfileLoading } = useCurrentUser();
  const currentUserAvatarShape = getAvatarShape(metadata);
  const { currentUser, otherUsers, setLogin } = useLoggedInAccounts();
  const { logout } = useLoginActions();

  const {
    orderedItems, hiddenItems, updateSidebarOrder, addToSidebar, addDividerToSidebar, removeFromSidebar,
  } = useFeedSettings();
  const { config } = useAppContext();

  const visibleItems = orderedItems;
  const visibleHiddenItems = hiddenItems;

  const hasUnread = useHasUnreadNotifications();
  const userProfileUrl = useProfileUrl(user?.pubkey ?? '', metadata);
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const { startSignup } = useOnboarding();
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false);
  const [followQROpen, setFollowQROpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  // NIP-38 status
  const userStatus = useUserStatus(user?.pubkey);
  const publishStatus = usePublishStatus();
  const { toast } = useToast();
  const [statusEditing, setStatusEditing] = useState(false);
  const [statusDraft, setStatusDraft] = useState('');

  const homePage = config.homePage;

  const scrollToTopIfCurrent = useCallback((to: string) => (e: React.MouseEvent) => {
    if (location.pathname === to) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [location.pathname]);

  const getDisplayName = (account: Account) =>
    account.metadata.name || account.metadata.display_name || genUserName(account.pubkey);

  const handleLogout = async () => {
    setAccountPopoverOpen(false);
    await logout();
    navigate('/');
  };

  return (
    <aside className="hidden sidebar:flex flex-col h-screen sticky top-0 py-3 px-4 w-[300px] lg:w-1/4 lg:max-w-[300px] shrink-0">
      {/* Logo — no pill wrapper, skin DittoLogo renders nori in real color */}
      <div className="flex items-center px-3 mb-2">
        <Link to="/" onClick={scrollToTopIfCurrent('/')} className="block">
          <DittoLogo size={48} />
        </Link>
      </div>

      {/* Search */}
      <div className="px-2 pt-2 pb-3">
        <ProfileSearchDropdown placeholder="Search..." inputClassName="py-3.5" enableTextSearch />
      </div>

      {/* Section header above nav — borrows the dashboard's
          uppercase tracked-wide rail label pattern */}
      <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-[0.12em] uppercase text-muted-foreground">
        Navigation
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <SidebarNavList
          items={visibleItems}
          editing={editing}
          onRemove={removeFromSidebar}
          onReorder={updateSidebarOrder}
          isActive={(id) => isItemActive(id, location.pathname, location.search, userProfileUrl, homePage)}
          getOnClick={(id) => id === homePage ? scrollToTopIfCurrent('/') : undefined}
          getProfilePath={(id) => id === 'profile' ? userProfileUrl : undefined}
          getShowIndicator={(id) => id === 'notifications' ? hasUnread : undefined}
          homePage={homePage}
        />

        <SidebarMoreMenu
          editing={editing}
          hiddenItems={visibleHiddenItems}
          onDoneEditing={() => setEditing(false)}
          onStartEditing={() => setEditing(true)}
          onAdd={addToSidebar}
          onAddDivider={addDividerToSidebar}
          open={moreMenuOpen}
          onOpenChange={setMoreMenuOpen}
          homePage={homePage}
        />
      </nav>

      {/* Logged-out join CTA — square, slightly tighter than upstream */}
      {!user && location.pathname !== '/' && (
        <div className="pt-2 pb-1">
          <button
            onClick={() => setLoginDialogOpen(true)}
            className="flex items-center justify-center w-full h-9 rounded-sm bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors cursor-pointer"
          >
            Join
          </button>
        </div>
      )}

      {/* User profile at bottom — square, no resting bg-pill */}
      {user && currentUser && (
        <div className="pt-2">
          <Popover open={accountPopoverOpen} onOpenChange={setAccountPopoverOpen}>
            <PopoverTrigger asChild>
              <button className="flex items-center gap-3 p-2 rounded-sm hover:bg-secondary/60 transition-colors cursor-pointer w-full text-left">
                {isProfileLoading ? (
                  <Skeleton className="size-10 shrink-0 rounded-full" />
                ) : (
                  <Avatar shape={currentUserAvatarShape} className="size-10 shrink-0">
                    <AvatarImage src={metadata?.picture} alt={metadata?.name} />
                    <AvatarFallback className="bg-primary/20 text-primary text-sm">
                      {(metadata?.name || metadata?.display_name || genUserName(user.pubkey))[0]?.toUpperCase() ?? '?'}
                    </AvatarFallback>
                  </Avatar>
                )}
                <div className="flex flex-col min-w-0 flex-1 gap-1">
                  {isProfileLoading ? (
                    <><Skeleton className="h-3.5 w-24" /><Skeleton className="h-3 w-16" /></>
                  ) : (
                    <>
                      <span className="font-semibold text-sm truncate">
                        {currentUserEvent && (metadata?.name || metadata?.display_name)
                          ? <EmojifiedText tags={currentUserEvent.tags}>{metadata.name || metadata.display_name || ''}</EmojifiedText>
                          : (metadata?.name || metadata?.display_name || genUserName(user.pubkey))}
                      </span>
                      {metadata?.nip05 && (
                        <VerifiedNip05Text nip05={metadata.nip05} pubkey={user.pubkey} className="text-xs text-muted-foreground truncate" />
                      )}
                    </>
                  )}
                </div>
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={8}
              className="w-[260px] p-0 rounded-md shadow-lg border border-border overflow-hidden"
            >
              {/* Current user */}
              <Link to={userProfileUrl} onClick={() => setAccountPopoverOpen(false)} className="block p-4 border-b border-border hover:bg-secondary/60 transition-colors">
                <div className="flex items-center gap-3">
                  <Avatar shape={currentUserAvatarShape} className="size-11 shrink-0">
                    <AvatarImage src={currentUser.metadata.picture} alt={getDisplayName(currentUser)} />
                    <AvatarFallback className="bg-primary/20 text-primary text-sm">{getDisplayName(currentUser).charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col min-w-0">
                    <span className="font-semibold text-sm truncate">
                      {currentUser.event ? <EmojifiedText tags={currentUser.event.tags}>{getDisplayName(currentUser)}</EmojifiedText> : getDisplayName(currentUser)}
                    </span>
                    {currentUser.metadata.nip05 && (
                      <VerifiedNip05Text nip05={currentUser.metadata.nip05} pubkey={currentUser.pubkey} className="text-xs text-muted-foreground truncate" />
                    )}
                  </div>
                </div>
              </Link>

              {/* Status editor */}
              <div className="border-b border-border">
                {statusEditing ? (
                  <div className="p-3 space-y-2">
                    <Input
                      value={statusDraft}
                      onChange={(e) => setStatusDraft(e.target.value.slice(0, 80))}
                      placeholder="What are you up to?"
                      className="h-8 text-base md:text-sm"
                      maxLength={80}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const text = statusDraft.trim();
                          publishStatus.mutateAsync({ status: text }).then(() => {
                            setStatusEditing(false);
                            setStatusDraft('');
                            toast({ title: text ? 'Status updated' : 'Status cleared' });
                          });
                        } else if (e.key === 'Escape') {
                          setStatusEditing(false);
                          setStatusDraft('');
                        }
                      }}
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => {
                          const text = statusDraft.trim();
                          publishStatus.mutateAsync({ status: text }).then(() => {
                            setStatusEditing(false);
                            setStatusDraft('');
                            toast({ title: text ? 'Status updated' : 'Status cleared' });
                          });
                        }}
                        disabled={publishStatus.isPending}
                        className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                      >
                        {publishStatus.isPending ? <Loader2 className="size-3 animate-spin" /> : 'Save'}
                      </button>
                      {userStatus.status && (
                        <button
                          onClick={() => {
                            publishStatus.mutateAsync({ status: '' }).then(() => {
                              setStatusEditing(false);
                              setStatusDraft('');
                              toast({ title: 'Status cleared' });
                            });
                          }}
                          disabled={publishStatus.isPending}
                          className="text-xs font-medium text-destructive hover:underline disabled:opacity-50"
                        >
                          Clear
                        </button>
                      )}
                      <button
                        onClick={() => { setStatusEditing(false); setStatusDraft(''); }}
                        className="text-xs text-muted-foreground hover:underline ml-auto"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setStatusEditing(true);
                      setStatusDraft(userStatus.status ?? '');
                    }}
                    className={cn(
                      'flex items-center gap-3 w-full px-4 py-2.5 text-sm hover:bg-secondary/60 transition-colors',
                      !userStatus.status && 'text-muted-foreground',
                    )}
                  >
                    {userStatus.status ? (
                      <span className="truncate text-muted-foreground italic text-xs pr-1">{userStatus.status}</span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-[0.12em]">Set a status</span>
                    )}
                  </button>
                )}
              </div>

              {/* Other accounts */}
              {otherUsers.length > 0 && (
                <div className="border-b border-border">
                  {otherUsers.map((account) => (
                    <button key={account.id} onClick={() => { setLogin(account.id); setAccountPopoverOpen(false); }} className="flex items-center gap-3 w-full px-4 py-3 hover:bg-secondary/60 transition-colors">
                      <Avatar shape={getAvatarShape(account.metadata)} className="size-9 shrink-0">
                        <AvatarImage src={account.metadata.picture} alt={getDisplayName(account)} />
                        <AvatarFallback className="bg-primary/20 text-primary text-xs">{getDisplayName(account).charAt(0).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate">
                          {account.event ? <EmojifiedText tags={account.event.tags}>{getDisplayName(account)}</EmojifiedText> : getDisplayName(account)}
                        </span>
                        {account.metadata.nip05 && <VerifiedNip05Text nip05={account.metadata.nip05} pubkey={account.pubkey} className="text-xs text-muted-foreground truncate" />}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="py-1">
                <button onClick={() => { setAccountPopoverOpen(false); setFollowQROpen(true); }} className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium hover:bg-secondary/60 transition-colors">
                  <QrCode className="size-4 text-muted-foreground" />
                  <span>Share profile</span>
                </button>
                <button onClick={() => { setAccountPopoverOpen(false); setLoginDialogOpen(true); }} className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium hover:bg-secondary/60 transition-colors">
                  <UserPlus className="size-4 text-muted-foreground" />
                  <span>Add another account</span>
                </button>
                <button onClick={handleLogout} className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors">
                  <LogOut className="size-4" />
                  <span>Log out @{metadata?.name || metadata?.display_name || genUserName(user.pubkey)}</span>
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}

      <LoginDialog isOpen={loginDialogOpen} onClose={() => setLoginDialogOpen(false)} onLogin={() => setLoginDialogOpen(false)} onSignupClick={startSignup} />
      <FollowQRDialog open={followQROpen} onOpenChange={setFollowQROpen} />
    </aside>
  );
}
