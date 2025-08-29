const {
   patcher,
   observeDom,
   http: { intercept },
} = shelter.plugin.scoped;

const {
   flux: {
      stores: { PermissionStore, ChannelStore, GuildStore, ReadStateStore },
   },
   ui: { renderSolidInReact, SwitchItem },
   util: { getFiber, reactFiberWalker },
   plugin: { store }
} = shelter;

const Permissions = {
   VIEW_CHANNEL: 1024n,
};

const ChannelTypes = {
   GUILD_TEXT: 0,
   DM: 1,
   GUILD_VOICE: 2,
   GROUP_DM: 3,
   GUILD_CATEGORY: 4,
   GUILD_ANNOUNCEMENT: 5,
   ANNOUNCEMENT_THREAD: 10,
   PUBLIC_THREAD: 11,
   PRIVATE_THREAD: 12,
   GUILD_STAGE_VOICE: 13,
   GUILD_DIRECTORY: 14,
   GUILD_FORUM: 15,
   GUILD_MEDIA: 16, // Beta channel type, check if it works sometime:tm:
};
store.ShowPeopleWhoHaveAccess ??= false
const getChannel = ChannelStore.getChannel;
const getGuild = GuildStore.getGuild;

const originalCan = PermissionStore.can.bind({});

import Notice from "./assets/Notice.jsx";
import classes from "./assets/style.scss";

function canBeSeen(channel) {
   return originalCan(Permissions.VIEW_CHANNEL, channel);
}

const isRestrictedChannel = (channel) => {
   return channel?.permissionOverwrites?.length > 0;
};

const isVisibile = (originalChannel) => {
   let channel = originalChannel;
   if (typeof channel !== "object" && !channel?.id) {
      try {
         channel = getChannel(channel);
      } catch {
         channel = null;
      } // Just in case Discord fucks up permissions again, so it doesn't crash.
   }

   // Exclude DM channels or invalid channels
   if (
      !channel ||
      [
         ChannelTypes.DM,
         ChannelTypes.GROUP_DM,
         ChannelTypes.GUILD_CATEGORY,
         ChannelTypes.GUILD_STORE,
         ChannelTypes.GUILD_DIRECTORY,
      ].includes(channel.type)
   )
      return true;

   return canBeSeen(channel);
};

export const settings = () => (
    <SwitchItem value={store.ShowPeopleWhoHaveAccess} onChange={(v) => {store.ShowPeopleWhoHaveAccess = v}}>
        show users/roles with access to hidden channels
    </SwitchItem>
)

export function onLoad() {
   patcher.instead("can", PermissionStore.__proto__, (originalArgs, originalFunction) => {
      if (originalArgs[0] === Permissions.VIEW_CHANNEL && !isRestrictedChannel(originalArgs[1])) return true;

      return originalFunction(...originalArgs);
   });

   let patchedChannelItem = false;
   const stopObservingChannelItem = observeDom('[data-list-item-id^="channels___"', (element) => {
      queueMicrotask(() => {
         const channelId = element.dataset.listItemId.split("___")[1];
         if (Number.isNaN(Number.parseInt(channelId))) return;

         const component = reactFiberWalker(getFiber(element), "aria-label", true, true)?.type;

         if (!component || typeof component.render !== "function") return;

         stopObservingChannelItem();

         if (patchedChannelItem) {
            return;
         }
         patchedChannelItem = true;

         patcher.before("render", component, (originalArgs) => {
            if (!originalArgs[0]["data-list-item-id"]) return originalArgs;

            const channelId = originalArgs[0]["data-list-item-id"].split("___")[1];

            if (!isVisibile(channelId)) {
               originalArgs[0].className += ` ${classes.hiddenChannel}`;
            }

            return originalArgs;
         });

         const channelReadState = ReadStateStore.getForDebugging(channelId);
         patcher.after("canTrackUnreads", channelReadState.__proto__, function (_, previousReturn) {
            return previousReturn && isVisibile(this.channelId);
         });
      });
   });

   let routePatched = false;
   const stopObservingRoute = observeDom('[class^="chat_"]', (element) => {
      queueMicrotask(() => {
         const component = reactFiberWalker(getFiber(element), "computedMatch", true, true)?.type;
         if (!component || typeof component.prototype.render !== "function") return;

         stopObservingRoute();

         if (routePatched) return;
         routePatched = true;

         patcher.before("render", component.prototype, function (originalArgs) {
            if (this.props?.path?.length !== 3) return originalArgs;

            const channelId = this.props?.computedMatch?.params?.channelId;
            const guildId = this.props?.computedMatch?.params?.guildId;

            if (!isVisibile(channelId) && guildId) {
               this.props.render = () => {
                  return renderSolidInReact(Notice, {
                     channel: getChannel(channelId),
                     guild: getGuild(guildId),
                  });
               };
            }

            return originalArgs;
         });
      });
   });

   intercept("GET", /\/channels\/\d+\/messages/, (req, send) => {
      const channelId = req.url.split("/")[2];
      if (!isVisibile(channelId)) {
         return Promise.resolve({
            status: 200,
            body: JSON.stringify({
               messages: [],
               hasMore: false,
            }),
         });
      }
      return send(req);
   });
}
