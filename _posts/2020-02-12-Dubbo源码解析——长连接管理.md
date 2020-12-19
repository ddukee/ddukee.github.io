---
layout: post
title: Dubbo源码解析——长连接管理
date: "2020-02-12 18:30:00 +0800"
categories: Dubbo
tags: java Dubbo rpc
published: true
---

## 前言

在[《Dubbo源码解析——远程通信》](/2020/02/06/Dubbo源码解析-远程通信)一文中我们分析了Dubbo通信层的架构，Dubbo协议在服务提供者和消费者之间通过维护一个TCP长连接来进行通信，既然是TCP长连接通信，那么如果在建立连接以后网络环境出现问题，或者服务器或客户端意外宕机导致服务端和客户端之间连接断开了，这个时候该如何维护这个长连接呢？为了解决这些问题，Dubbo提供了一些机制来保证长连接的可靠性，比如：心跳检测。下面，我们就来讲讲Dubbo是如何实现心跳检测的。

## 心跳检测

当我们在客户端和服务端之间建立起一个TCP连接以后，如果连接的两方长时间不进行通信，那么双方将不知道对端是否已经下线。在一个长连接两端的两个系统，由于自身所处网络的情况以及应用主机的情况，可能会出现多种情况导致连接不可用，比如：

* 服务器和客户端之间网络出现问题，导致网络不通，连接断开。
* 服务器或客户端由于非正常的关闭操作导致不能正常发出FIN包关闭连接，比如应用Crash、节点宕机、拔网线等等。

当出现上述情况的时候，如果连接的两端在这段时间中没有数据交换，那么将感知到不到连接其实已经不可用，这无形中会占用连接资源（端口），导致资源的浪费。在这种情况下，我们需要一种方案可以检测到这种连接不可用的发生。对于TCP协议来说，TCP本身提供了传输层的心跳检测能力，通过开启`SO_KEEPALIVE`套接字选项来启用通信层的心跳检测功能。

### TCP keepalive

TCP keepalive是一种检测TCP连接是否可以用的心跳检测机制。是TCP网络栈实现自己提供的一种连接检测功能是由具体操作系统提供的功能，应用程序可以通过配置套接字（Socket）的`SO_KEEPALIVE`选项来开启。

当TCP keepalive功能启用以后，TCP会在连接空闲超过一段时间以后以固定的频率向连接的另一端发送探查包。接收端收到探查包以后需要正确处理心跳探查包以告知发送端连接是健康的。

在Linux下，关于TCP keepalive的配置在`/proc/sys/net/ipv4`目录下的这三个文件中：

{% highlight text %}
$ cat /proc/sys/net/ipv4/tcp_keepalive_time
7200

$ cat /proc/sys/net/ipv4/tcp_keepalive_intvl
75

$ cat /proc/sys/net/ipv4/tcp_keepalive_probes
9
{% endhighlight %}

分别对应了TCP keepalive的三个选项的配置值：

* tcp_keepalive_time = 7200 (seconds)
* tcp_keepalive_intvl = 75 (seconds)
* tcp_keepalive_probes = 9 (number of probes)

这三个选项的含义是：TCP如果开启了keepalive选项，那么连接会在连接空闲2小时（7200秒）以后发送第一个探针，往后每隔75秒发送一个探针，直到连接的对端响应探针或者发送探针的数量达到配置值9个。如果发送的探针数量达到配置值，但是连接仍旧是没有响应，那么内核将向应用层通知连接断开的消息。

在Linux下可以通过`procfs`或`sysctl`配置keepalive内核参数，一旦配置以后整个配置就是全局的，操作系统上的所有应用都运用同一套keepalive配置。这对于一些想要灵活配置自己的心跳检测时间的应用来说不够灵活，所以一些应用会在网络的应用层基于TCP协议自己实现心跳检测服务，比如Dubbo就内置了自己的心跳检测能力。

### Heartbeat

Dubbo在应用层自己实现一套心跳检测机制，通过在服务端和客户端之间发送心跳包的方式检测连接是否健康。心跳检测任务在启动客户端的时候被设置，心跳检测启动代码在`HeaderExchangeClient`中：

{% highlight java %}
public class HeaderExchangeClient implements ExchangeClient {
  /* 省略 */
  private static final HashedWheelTimer IDLE_CHECK_TIMER = new HashedWheelTimer(
        new NamedThreadFactory("dubbo-client-idleCheck", true), 1, TimeUnit.SECONDS, TICKS_PER_WHEEL); // 1
  private HeartbeatTimerTask heartBeatTimerTask; // 2
  
  /* 省略 */  
  public HeaderExchangeClient(Client client, boolean startTimer) {
    Assert.notNull(client, "Client can't be null");
    this.client = client;
    this.channel = new HeaderExchangeChannel(client);

    if (startTimer) {
        URL url = client.getUrl();
        startReconnectTask(url);
        startHeartBeatTask(url); // 3
    }
  }
  
  private void startHeartBeatTask(URL url) {
      if (!client.canHandleIdle()) {
          AbstractTimerTask.ChannelProvider cp = () -> Collections.singletonList(HeaderExchangeClient.this); // 4
          int heartbeat = getHeartbeat(url); // 5
          long heartbeatTick = calculateLeastDuration(heartbeat); // 6
          this.heartBeatTimerTask = new HeartbeatTimerTask(cp, heartbeatTick, heartbeat); // 7
          IDLE_CHECK_TIMER.newTimeout(heartBeatTimerTask, heartbeatTick, TimeUnit.MILLISECONDS); // 8
      }
  }
}
{% endhighlight %}

1. 设置定时器，`HashedWheelTimer`定时器采用非精确的定时机制来提高性能。这里直接用了Netty中提供的`HashedWheelTimer`实现。
2. 设置心跳包发送任务。
3. 启动心跳检测定任务。
4. 设置需要发送心跳包的`Channel`。
5. 获取心跳间隔时间，可以通过`heartbeat`参数进行配置，默认值为60秒，心跳间隔不能低于1秒。
6. 计算心跳的时钟滴答（Tick），`HashedWheelTimer`是通过时钟滴答而不是秒来进行计时的。
7. 创建心跳任务，心跳任务是一个`TimerTask`对象，在定时器超时以后会执行`TimerTask`的`run()`方法。
8. 设置定时任务。

下面我们来看下心跳任务`HeartbeatTimerTask`是怎么发送心跳包的。`HeartbeatTimerTask`继承了`AbstractTimerTask`，在`AbstractTimerTask`中提供了一个供子类实现的`doTask()`抽象方法，提具体任务调度的流程统一在`AbstractTimerTask`中实现。

{% highlight java %}
public abstract class AbstractTimerTask implements TimerTask
  private void reput(Timeout timeout, Long tick) {
      if (timeout == null || tick == null) {
          throw new IllegalArgumentException();
      }
      if (cancel) {
          return;
      }
      Timer timer = timeout.timer();
      if (timer.isStop() || timeout.isCancelled()) {
          return;
      }
      timer.newTimeout(timeout.task(), tick, TimeUnit.MILLISECONDS);
  }

  public void run(Timeout timeout) throws Exception {
      Collection<Channel> c = channelProvider.getChannels();
      for (Channel channel : c) {
          if (channel.isClosed()) {
              continue;
          }
          doTask(channel);
      }
      reput(timeout, tick);
  }
}
{% endhighlight %}

当超时时间到达以后，在`run()`方法中会调用由子类实现的`doTask()`方法，然后调用`reput()`方法将任务再次设置到定时器中。下面是`HeartbeatTimerTask`的`doTask()`实现：

{% highlight java %}
public class HeartbeatTimerTask extends AbstractTimerTask {
  protected void doTask(Channel channel) {
      try {
          Long lastRead = lastRead(channel); // 1
          Long lastWrite = lastWrite(channel); // 2
          if ((lastRead != null && now() - lastRead > heartbeat)
                  || (lastWrite != null && now() - lastWrite > heartbeat)) { // 3
              Request req = new Request();
              req.setVersion(Version.getProtocolVersion());
              req.setTwoWay(true);
              req.setEvent(Request.HEARTBEAT_EVENT); // 4
              channel.send(req); // 5
              if (logger.isDebugEnabled()) {
                  logger.debug("Send heartbeat to remote channel " + channel.getRemoteAddress()
                          + ", cause: The channel has no data-transmission exceeds a heartbeat period: "
                          + heartbeat + "ms");
              }
          }
      } catch (Throwable t) {
          logger.warn("Exception when heartbeat to remote channel " + channel.getRemoteAddress(), t);
      }
  }
}
{% endhighlight %}

1. 获取`channel`对应的网络连接最近一个请求的时间。这个时间记录在`Channel`附带的`READ_TIMESTAMP`属性（Attribute）中。
2. 获取`channel`对应的网络连接最近一次响应的时间。这个时间记录在`Channel`附带的`WRITE_TIMESTAMP`属性（Attribute）中。
3. 计算最近一次请求或响应时间和当前时间之间的差值，以判断据上一次网络请求过去了多久。如果这个时间超过了配置的`heartbeat`时间（默认60秒），则需要发送心跳包检测连接是否可用。
4. 设置Dubbo协议包的心跳事件，在Dubbo的二进制协议中有一个事件位（bit）用于标记该网络包是心跳检测数据包。
5. 向对端发送心跳包。

通过上面的`HeartbeatTimerTask`任务我们已经具有了发送心跳包的能力，那么Dubbo是如何记录心跳信息的呢？

上面我们在分析`HeartbeatTimerTask`的获取请求时间（点1）和获取响应时间（点2）的时候看到了，Dubbo通过读取`Channel`的`READ_TIMESTAMP`和`WRITE_TIMESTAMP`属性值来获取最近一次的请求和响应时间。Dubbo就是通过在`Channel`上用这两个属性值来记录一个连接的最近一次发送请求和接收请求的时间的。Dubbo分别在Transport层和Exchange层记录了连接的这两个时间。

在Exchange层中，`HeaderExchangeHandler`在`received()`接收到请求、`sent()`发送响应成功、连接建立`connected()`以后连接断开`disconnected()`以后会在连接对应的`Channel`上记录下对应的`READ_TIMESTAMP`和`WRITE_TIMESTAMP`时间戳：

{% highlight java %}
@Override
public void disconnected(Channel channel) throws RemotingException {
    channel.setAttribute(KEY_READ_TIMESTAMP, System.currentTimeMillis());
    channel.setAttribute(KEY_WRITE_TIMESTAMP, System.currentTimeMillis());
    /* 省略 */
}

@Override
public void connected(Channel channel) throws RemotingException {
    channel.setAttribute(KEY_READ_TIMESTAMP, System.currentTimeMillis());
    channel.setAttribute(KEY_WRITE_TIMESTAMP, System.currentTimeMillis());
    /* 省略 */
}

@Override
public void received(Channel channel, Object message) throws RemotingException {
    channel.setAttribute(KEY_READ_TIMESTAMP, System.currentTimeMillis());
    /* 省略 */
}

@Override
public void sent(Channel channel, Object message) throws RemotingException {
    try {
        channel.setAttribute(KEY_WRITE_TIMESTAMP, System.currentTimeMillis());
        /* 省略 */
    }
}
{% endhighlight %}

在Transport层则是通过`HeartbeatHandler`装饰器包装`ChannelHandler`来实现记录心跳时间戳的。同时在`HeartbeatHandler`中会判断请求是否是心跳请求，如果是心跳请求则直接在Transport层处理，不会向上传递给Exchange层。`HeartbeatHandler`对`ChannelHandler`的包装和[《Dubbo源码解析——线程模型》](/2020/02/10/Dubbo源码解析——线程模型)中关于线程模型的实现一样，都是在`AbstractClient.wrapChannelHandler()`中调用`ChannelHandlers.wrap()`完成的：

{% highlight java %}
public class ChannelHandlers {
  public static ChannelHandler wrap(ChannelHandler handler, URL url) {
      return ChannelHandlers.getInstance().wrapInternal(handler, url);
  }

  protected ChannelHandler wrapInternal(ChannelHandler handler, URL url) {
      return new MultiMessageHandler(new HeartbeatHandler(ExtensionLoader.getExtensionLoader(Dispatcher.class)
              .getAdaptiveExtension().dispatch(handler, url)));
  }
}
{% endhighlight %}

在`wrapInternal()`中将传入的`ChannelHandler`实例包装上`HeartbeatHandler`来拦截所有事件处理方法：

{% highlight java %}
public class HeartbeatHandler extends AbstractChannelHandlerDelegate {
    public static final String KEY_READ_TIMESTAMP = "READ_TIMESTAMP";
    public static final String KEY_WRITE_TIMESTAMP = "WRITE_TIMESTAMP";

    /* 省略 */

    @Override
    public void connected(Channel channel) throws RemotingException {
        setReadTimestamp(channel); // 1
        setWriteTimestamp(channel);
        handler.connected(channel);
    }

    @Override
    public void disconnected(Channel channel) throws RemotingException {
        clearReadTimestamp(channel); // 1
        clearWriteTimestamp(channel);
        handler.disconnected(channel);
    }

    @Override
    public void sent(Channel channel, Object message) throws RemotingException {
        setWriteTimestamp(channel); // 1
        handler.sent(channel, message);
    }

    @Override
    public void received(Channel channel, Object message) throws RemotingException {
        setReadTimestamp(channel);
        if (isHeartbeatRequest(message)) { // 2
            Request req = (Request) message;
            if (req.isTwoWay()) {
                Response res = new Response(req.getId(), req.getVersion());
                res.setEvent(Response.HEARTBEAT_EVENT);
                channel.send(res); // 2
                if (logger.isInfoEnabled()) {
                    int heartbeat = channel.getUrl().getParameter(Constants.HEARTBEAT_KEY, 0);
                    if (logger.isDebugEnabled()) {
                        logger.debug("Received heartbeat from remote channel " + channel.getRemoteAddress()
                                + ", cause: The channel has no data-transmission exceeds a heartbeat period"
                                + (heartbeat > 0 ? ": " + heartbeat + "ms" : ""));
                    }
                }
            }
            return;
        }
        if (isHeartbeatResponse(message)) { // 2
            if (logger.isDebugEnabled()) {
                logger.debug("Receive heartbeat response in thread " + Thread.currentThread().getName());
            }
            return;
        }
        handler.received(channel, message);
    }

    /* 省略 */
}
{% endhighlight %}

1. 拦截`connected()`、`disconnected()`、`received()`、`sent()`方法的调用并设置时间戳。
2. 检查请求（响应）是否是心跳请求（响应），如果是则直接在这个`ChannelHandler`中处理，不会传递给应用层。

下面是`HeartbeatHandler`和`HeaderExchangeHandler`两个处理器之间的关系和数据流，关于通信层的具体内容可以参考[《Dubbo源码解析——远程通信》](/2020/02/06/Dubbo源码解析-远程通信)一文：

![heartbeat](/assets/images/rpc_3-1.png){:width="65%" hight="65%"}

心跳机制记录下了最近一次对连接读和写的时间戳，那么Dubbo是如何判断连接是可用还是不可用的呢？下面，我们先来看下Dubbo是如何判断连接断开和处理客户端重连的。


*注：上面我们介绍的心跳定时任务并不是在所有客户端和服务端中都会发送，对于Netty 4实现的`NettyClient`和`NettyServer`，它们没有使用Dubbo应用层实现的发送心跳探测包的方式实现心跳检测，而是采用了Netty框架自带的空闲连接检测处理器`IdleStateHandler`来实现心跳检测，所以对于Netty 4实现的Transport层并不会启用发送心跳探测包的任务。*

## 客户端重连

在客户端一侧，Dubbo通过启动一个`ReconnectTimerTask`超时任务来检查连接是否关闭并进行连接的重连过程。`ReconnectTimerTask`在`HeaderExchangeClient`中通过`startReconnectTask()`方法被启动。

{% highlight java %}
public class HeaderExchangeClient implements ExchangeClient {
  public HeaderExchangeClient(Client client, boolean startTimer) {
    Assert.notNull(client, "Client can't be null");
    this.client = client;
    this.channel = new HeaderExchangeChannel(client);

    if (startTimer) {
        URL url = client.getUrl();
        startReconnectTask(url); // 1
        startHeartBeatTask(url);
    }
  }
  /* 省略 */
  private void startReconnectTask(URL url) {
      if (shouldReconnect(url)) { // 2
          AbstractTimerTask.ChannelProvider cp = () -> Collections.singletonList(HeaderExchangeClient.this);
          int idleTimeout = getIdleTimeout(url); // 3
          long heartbeatTimeoutTick = calculateLeastDuration(idleTimeout);
          this.reconnectTimerTask = new ReconnectTimerTask(cp, heartbeatTimeoutTick, idleTimeout);
          IDLE_CHECK_TIMER.newTimeout(reconnectTimerTask, heartbeatTimeoutTick, TimeUnit.MILLISECONDS); // 4
      }
  }
}
{% endhighlight %}

1. 调用`startReconnectTask()`开启重连任务定时器。
2. 判断客户端是否启用了重连机制，Dubbo通过配置参数`reconnect`来启用或关闭重连机制，默认为`true`开启。
3. 获取连接空闲超时时间，当连接空闲的时间超过这个阈值就会触发Dubbo的连接重建过程。超时时间可以通过参数`heartbeat.timeout`配置，默认值为Dubbo设置的心跳超时时间`heartbeat`的三倍，同时`heartbeat.timeout`的设置值不能低于`heartbeat`设置值的两倍。当`heartbeat`使用默认值60秒的情况下，空闲连接的超时时间为三分钟（180秒）。
4. 设置`ReconnectTimerTask`任务并启动定时器。

下面我们看下`ReconnectTimerTask`中是如何判断连接不可用和重建连接的，和`HeartbeatTimerTask`一样，`ReconnectTimerTask`也是继承自`AbstractTimerTask`，通过实现`doTask()`来提供超时以后的处理任务。

{% highlight java %}
@Override
protected void doTask(Channel channel) {
    try {
        Long lastRead = lastRead(channel); // 1
        Long now = now();

        // Rely on reconnect timer to reconnect when AbstractClient.doConnect fails to init the connection
        if (!channel.isConnected()) { // 2
            try {
                logger.info("Initial connection to " + channel);
                ((Client) channel).reconnect(); //2
            } catch (Exception e) {
                logger.error("Fail to connect to " + channel, e);
            }
        // check pong at client
      } else if (lastRead != null && now - lastRead > idleTimeout) { // 3
            logger.warn("Reconnect to channel " + channel + ", because heartbeat read idle time out: "
                    + idleTimeout + "ms");
            try {
                ((Client) channel).reconnect(); // 3
            } catch (Exception e) {
                logger.error(channel + "reconnect failed during idle time.", e);
            }
        }
    } catch (Throwable t) {
        logger.warn("Exception when reconnect to remote channel " + channel.getRemoteAddress(), t);
    }
}
{% endhighlight %}

1. 从记录的时间戳中获取最近一次读连接的时间。
2. 判断`Channel`是否是打开的，如果是关闭的，则调用`reconnect()`尝试重建连接。否则判断时间是否超时。
3. 判断距离上一次读连接的时间间隔是否超过空闲时间的阈值，如果超过则调用`reconnect()`尝试重建连接。

## 服务端空闲连接检测

在客户端中，通过`startReconnectTask`来启动一个连接重建任务定时检测连接是否可用。在服务端中，也有类似的机制检测连接是否处于不可用状态，以及时回收降低资源占用。

在服务端一侧，通过设置一个`CloseTimerTask`定时任务来检查连接到服务端的连接是否是正常的。如果连接的空闲时间超过设置的阈值，`CloseTimerTask`会调用`close()`方法关闭连接。这个检测空闲连接的定时在`HeaderExchangeServer`中启用。

{% highlight java %}
public class HeaderExchangeServer implements ExchangeServer {
  public HeaderExchangeServer(Server server) {
    Assert.notNull(server, "server == null");
    this.server = server;
    startIdleCheckTask(getUrl()); // 1
  }
  /* 省略 */
  private void startIdleCheckTask(URL url) {
      if (!server.canHandleIdle()) {
          AbstractTimerTask.ChannelProvider cp = () -> unmodifiableCollection(HeaderExchangeServer.this.getChannels()); // 2
          int idleTimeout = getIdleTimeout(url); // 3
          long idleTimeoutTick = calculateLeastDuration(idleTimeout);
          CloseTimerTask closeTimerTask = new CloseTimerTask(cp, idleTimeoutTick, idleTimeout); // 4
          this.closeTimerTask = closeTimerTask;

          // init task and start timer.
          IDLE_CHECK_TIMER.newTimeout(closeTimerTask, idleTimeoutTick, TimeUnit.MILLISECONDS); // 4
      }
  }
}
{% endhighlight %}

1. 调用`startIdleCheckTask()`启动空闲连接检查的定时任务。
2. 设置需要被检查的连接，这里将所有连接到服务端的连接都放入被检查的连接列表。
3. 获取设置的超时阈值，这个值和客户端空闲连接超时时间的取值规则一样，以`heartbeat`设置值的三倍为默认值，最小不能低于`heartbeat`设置值的两倍。默认值为3分钟。
4. 将`CloseTimerTask`任务设置到定时器中。

在`CloseTimerTask`中会检查连接最近一次的读和写的时间戳，如果当前时间和这两个时间中的任意一个的间隔超过了设置的空闲时间阈值，则调用`Channel`的`close()`方法关闭连接。关闭连接以后，由客户端在`ReconnectTimerTask()`中负责连接的重建过程。

{% highlight java %}
public class CloseTimerTask extends AbstractTimerTask {
  /* 省略 */
  @Override
  protected void doTask(Channel channel) {
      try {
          Long lastRead = lastRead(channel);
          Long lastWrite = lastWrite(channel);
          Long now = now();
          // check ping & pong at server
          if ((lastRead != null && now - lastRead > idleTimeout)
                  || (lastWrite != null && now - lastWrite > idleTimeout)) {
              logger.warn("Close channel " + channel + ", because idleCheck timeout: "
                      + idleTimeout + "ms");
              channel.close();
          }
      } catch (Throwable t) {
          logger.warn("Exception when close remote channel " + channel.getRemoteAddress(), t);
      }
  }
}
{% endhighlight %}

## IdleStateHandler

`IdleStateHandler`是Netty框架提供的一个事件处理器，用于检测连接是否空闲。当Channel对应的连接上在一段时间内没有读写事件的时候，`IdleStateHandler`就会向应用层触发事件。事件会被`ChannelInboundHandler`处理器的`userEventTriggered()`方法处理。Dubbo在Netty 4的客户端和服务端中就是利用了这个机制实现心跳检测和连接维护的。

使用`IdleStateHandler`处理器实现心跳检测的方案，由客户端设置心跳超时时间，如果心跳超时以后产生一个用户事件，被pipeline上的`userEventTriggered()`方法捕获并向服务端发起心跳请求。服务端接收到心跳请求以后响应客户端的请求。如果在服务端配置的`IdleStateHandler`超时（超时设置的时间和`CloseTimerTask`中设置的时间一样，三倍于心跳检测时间），则关闭连接。下面，我们看下源码部分：

{% highlight java %}
public class NettyClient extends AbstractClient {
    @Override
    protected void doOpen() throws Throwable {
        /* 省略 */
        bootstrap.handler(new ChannelInitializer() {

            @Override
            protected void initChannel(Channel ch) throws Exception {
                int heartbeatInterval = UrlUtils.getHeartbeat(getUrl());
                NettyCodecAdapter adapter = new NettyCodecAdapter(getCodec(), getUrl(), NettyClient.this);
                ch.pipeline()//.addLast("logging",new LoggingHandler(LogLevel.INFO))//for debug
                        .addLast("decoder", adapter.getDecoder())
                        .addLast("encoder", adapter.getEncoder())
                        .addLast("client-idle-handler", new IdleStateHandler(heartbeatInterval, 0, 0, MILLISECONDS)) // 1
                        .addLast("handler", nettyClientHandler);
                String socksProxyHost = ConfigUtils.getProperty(SOCKS_PROXY_HOST);
                if(socksProxyHost != null) {
                    int socksProxyPort = Integer.parseInt(ConfigUtils.getProperty(SOCKS_PROXY_PORT, DEFAULT_SOCKS_PROXY_PORT));
                    Socks5ProxyHandler socks5ProxyHandler = new Socks5ProxyHandler(new InetSocketAddress(socksProxyHost, socksProxyPort));
                    ch.pipeline().addFirst(socks5ProxyHandler);
                }
            }
        });
    }
    
    /* 省略 */
}

public class NettyClientHandler extends ChannelDuplexHandler {
  @Override
  public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
    // send heartbeat when read idle.
      if (evt instanceof IdleStateEvent) { // 2
          try {
              NettyChannel channel = NettyChannel.getOrAddChannel(ctx.channel(), url, handler);
              if (logger.isDebugEnabled()) {
                  logger.debug("IdleStateEvent triggered, send heartbeat to channel " + channel);
              }
              Request req = new Request();
              req.setVersion(Version.getProtocolVersion());
              req.setTwoWay(true);
              req.setEvent(Request.HEARTBEAT_EVENT);
              channel.send(req); // 3
          } finally {
              NettyChannel.removeChannelIfDisconnected(ctx.channel());
          }
     } else {
          super.userEventTriggered(ctx, evt);
      }
  }
}
{% endhighlight %}

1. 在客户端`NettyClient`中配置`IdleStateHandler`处理器，配置读空闲超时时间为心跳间隔，和`ReconnectTimerTask`中一样，通过`heartbeat`参数配置。
2. 在`userEventTriggered()`中捕获`IdleStateEvent`事件，并向服务端发送心跳。发送心跳以后会刷新空闲超时时间，等待下一次空闲的超时，同时如果连接是正常的，服务端也会在收到心跳消息的同时刷新超时时间。

我们再来看下在服务端是如何处理的：

{% highlight java %}
public class NettyServer extends AbstractServer implements Server {
  protected void doOpen() throws Throwable {
      bootstrap = new ServerBootstrap();

      bossGroup = new NioEventLoopGroup(1, new DefaultThreadFactory("NettyServerBoss", true));
      workerGroup = new NioEventLoopGroup(getUrl().getPositiveParameter(IO_THREADS_KEY, Constants.DEFAULT_IO_THREADS),
              new DefaultThreadFactory("NettyServerWorker", true));

      final NettyServerHandler nettyServerHandler = new NettyServerHandler(getUrl(), this);
      channels = nettyServerHandler.getChannels();

      bootstrap.group(bossGroup, workerGroup)
              .channel(NioServerSocketChannel.class)
              .childOption(ChannelOption.TCP_NODELAY, Boolean.TRUE)
              .childOption(ChannelOption.SO_REUSEADDR, Boolean.TRUE)
              .childOption(ChannelOption.ALLOCATOR, PooledByteBufAllocator.DEFAULT)
              .childHandler(new ChannelInitializer<NioSocketChannel>() {
                  @Override
                  protected void initChannel(NioSocketChannel ch) throws Exception {
                      // FIXME: should we use getTimeout()?
                      int idleTimeout = UrlUtils.getIdleTimeout(getUrl());
                      NettyCodecAdapter adapter = new NettyCodecAdapter(getCodec(), getUrl(), NettyServer.this);
                      ch.pipeline()//.addLast("logging",new LoggingHandler(LogLevel.INFO))//for debug
                              .addLast("decoder", adapter.getDecoder())
                              .addLast("encoder", adapter.getEncoder())
                              .addLast("server-idle-handler", new IdleStateHandler(0, 0, idleTimeout, MILLISECONDS)) // 1
                              .addLast("handler", nettyServerHandler);
                  }
              });
      // bind
      ChannelFuture channelFuture = bootstrap.bind(getBindAddress());
      channelFuture.syncUninterruptibly();
      channel = channelFuture.channel();
  }
}

public class NettyServerHandler extends ChannelDuplexHandler {
  @Override
  public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
      // server will close channel when server don't receive any heartbeat from client util timeout.
      if (evt instanceof IdleStateEvent) { // 2
          NettyChannel channel = NettyChannel.getOrAddChannel(ctx.channel(), url, handler);
          try {
              logger.info("IdleStateEvent triggered, close channel " + channel);
              channel.close(); // 3
          } finally {
              NettyChannel.removeChannelIfDisconnected(ctx.channel());
          }
      }
      super.userEventTriggered(ctx, evt);
  }
}
{% endhighlight %}

1. 在服务端中设置读写超时时间为`idleTimeout`的`IdleStateHandler`，这里的`idleTimeout`时间和`CloseTimerTask()`的超时时间是同一个值。如果一段时间内读和写都没有发送，`IdleStateHandler`会向应用层触发一个`IdleStateEvent`事件。
2. `NettyServerHandler`中会捕获由`IdleStateHandler`触发的`IdleStateEvent`事件，然后关闭连接。由于`IdleStateHandler`的超时时间是心跳时间的三倍，如果超时则表示连接处于不可用状态，所以可以之间把连接关闭。

## 总结
在本文中，我们介绍了Dubbo中长连接的维护机制。通过在客户端和服务端之间发送心跳探针来检查连接是否活跃，在`Channel`上设置读取时间和写入时间来供`CloseTimerTask`和`ReconnectTimerTask`定时任务处理连接的关闭和重建，或者利用Netty框架提供的`IdleStateHandler`来处理心跳检测。
