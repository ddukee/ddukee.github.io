---
layout: post
title: Zookeeper初探
date: "2019-02-11 17:08:00 +0800"
categories: distributed
tags: zookeeper middleware
published: true
---

## 什么是Zookeeper

Zookeeper是一个提供高性能分布式协调的中心化服务。最初由Yahoo实验室开发，后来捐献给了Apache基金会，成为Apache基金会的顶级项目。Zookeeper由Java语言开发，默认提供Java语言和C语言的API。

Zookeeper提供了一些通用的服务，包括命名服务、配置管理、同步以及组服务。除了通用服务，Zookeeper还提供了一套简单的API，开发人员可以利用Zookeeper提供的这套API，实现主选举（Leader Election）、分布式锁以及消息队列等分布式组件。Zookeeper本身并不提供分布式组件的实现，而是提供一套API和一些约束保证。开发人员利用这套API和Zookeeper提供的保证，可以自己实现分布式组件。

## 解决什么问题

在分布式环境中，应用程序运行在不同的物理机器，而物理机器可能分布在不同的地域，应用程序之间通过网络交换信息。

不同于传统的单机环境：互相通信的进程运行在同一台物理机器上，进程间通信通过操作系统提供的IPC进行通信，本质上所有进程都运行在同样的物理介质上。分布式环境中涉及到多个机器上的进程间通信，运行在不同的物理介质，不同机器分布在不同的地域，在不同的网络环境下进行数据交换，因此面临着众多的技术挑战，包括：网络分区，机器故障、不可信的网络环境、消息丢失等问题。当我们在开发自己的分布式系统的时候，不可避免的需要面临和解决这些技术问题。 

Zookeeper提供了一个中心化的服务。通过Zookeeper提供的功能，在分布式环境下，应用程序通过和Zookeeper通信，利用中心化存储，实现分布式环境下各个节点的数据共享。当网络出现故障或其中参与分布式环境的机器宕机，Zookeeper可以感知到服务故障进而协调分布式环境下的各个应用程序。Zookeeper服务本身可以通过集群部署的方式实现高可用。

## 数据模型

Zookeeper本质上是一个KV存储的数据库。Zookeeper将数据维护在内存中，这有利于提高Zookeeper访问的吞吐量。不统于一般的KV存储数据库，Zookeeper采用类似于文件系统的树形结构来存储和管理数据。组成树的节点称为 **znode** ，Zookeeper中对于数据的维护都是基于对znode的操作。对znode的引用，通过从根节点遍历过来的路径名称来标识，称为 **path** 。下面就是一个典型的znode-tree的结构。

![znode-tree](/assets/images/znode-tree.jpg){:width="40%" height="40%"}

可以看到所有的znode组成了一棵znode-tree，而每个znode的命名和文件系统类似。从根节点开始，根节点用`/`来表示。第一层的znode为：`/app1`和`/app2`，第二层的znode为：`/app1/p_1`、`/app1/p_2`、`/app1/p_3`，整棵树定义了znode的命名空间。

### znode模式
在Zookeeper中，Znode有两种模式，分别是：**持久模式（Persistent）** 和 **临时模式（Ephemeral）** 两种模式。其中Persistent模式下的znode，一旦创建以后，除非通过delete方式删除，否则一直存在。而Ephemeral模式下的znode，当创建该znode的session超时，或者创建该znode的session关闭，改znode就会自动被Zookeeper删除。

Ephemeral模式下的znode，由于它特殊的特性：生命周期随着Session的消亡而消亡的机制。可以用来处理临时持有资源的场景，比如分布式锁就是一个特别适合的使用场景。特别的，结合Watcher机制，可以用来实现服务的健康检查。

Znode除了上面提到的两种工作模式，它还有两种类型：普通节点和顺序节点(Sequential znode)。默认创建的是普通节点，节点的名称就是创建的时候指定的名称。而顺序节点，顾名思义，节点是有序的。顺序节点在创建的时候，开发人员指定的节点名称只是节点的前缀，Zookeeper会自动在节点上按照递增的方式编号，编号的格式为`%10d`，顺序节点的编号为10位的整数，以前缀0的方式补齐，比如：`test-0000000001`。这种方式创建的节点保证了节点名称的唯一性。利用顺序节点的特性，可以实现有创建顺序要求的场景，比如实现一个队列。

两种工作模式加上两种类型，Zookeeper总共提供了四种类型的znode：
* Persistent Znode
* Persistent Sequential Znode
* Ephemeral Znode
* Ephemeral Sequential Znode

### Watcher
Zookeeper提供了一种通知机制，可以允许客户端在znode上面设置监听器(Watcher)，当znode的数据发生变更或者znode下面的子节点被创建或删除的时候，会触发Watcher。

Zookeeper的Watcher是单次触发（one-time-trigger）的，意味着一旦设置在某个znode上的Watcher被触发以后，这个Watcher就自动被移除了，下次znode的状态变更以后不会再触发这个Watcher。如果需要再次监听这个znode，则需要在这个znode上手动重新设置Watcher。

Zookeeper的通知机制采用了服务端主动通知的方式(push方式)，而没有采用客户端主动轮询（pull方式）。可以看下当采用客户端主动轮询的方式是怎样的一个工作机制：

![zk-pull](/assets/images/zk-pull.jpg){:width="80%" height="80%"}

可以看到，如果采用客户端主动轮询的方式，客户端需要按照一定的时间间隔向服务端轮询节点的状态。这种方式，一方面会增加网络消息的数量，另一方面也不能保证时效性。

![zk-push](/assets/images/zk-push.jpg){:width="80%" height="80%"}

Zookeeper采用的主动push的方式，C2先设置一个Watcher，然后当节点的事件触发了这个Watcher以后，Zookeeper服务端主动通知客户端，这种方式保证了时效性，但是服务端主动push的方式，当监听的客户端很多的情况下，会导致通知消息的扇出很大，影响服务端的性能。

### Version

每个znode都维护了版本号，每次znode被修改以后，版本号都会递增。Zookeeper对znode的setData操作和delete操作可以附加一个版本号，当版本号不匹配的时候，操作失败。当多个客户端尝试对同一个节点进行操作的时候，Zookeeper通过这种方式来支持CAS操作。

![zk-version](/assets/images/zk-version.jpg){:width="80%" height="80%"}

客户端c1在setData的时候带上了版本号`version = 2`，由于c2先于c1更新的这个znode，导致znode的当前版本号`version = 3`，版本号不匹配，c1的操作失败。

除了上面提到的version版本号，znode总共维护了三个版本号，分别是：
+ version - znode的data被修改的次数
+ cversion - znode的子节点被修改的次数
+ aversion - znode的ACL被修改的次数

## Zookeeper架构
Zookeeper支持两种运行模式，一种是单机运行，还有一种是支持HA的集群部署的运行模式。

集群中运行Zookeeper服务的节点称为 **ensemble**。在集群部署模式下，只要超过超过半数的ensemble正常运行，整个集群就可以提供服务。为了达到大多数（majority）的要求，集群中ensemble的数量最好是奇数个。如果集群中部署的ensemble的个数为4个，那么为了满足大多数的要求，该集群只能容忍1个ensemble故障。如果2个ensemble出现故障，那么剩下的2个ensemble由于不能达到大多数的前提，所以整个集群将不能继续提供服务。如果将集群中ensemble的数量控制到5个，那么整个集群可以容忍2个ensemble发生故障，而保证集群的可用性，因为剩下的3个ensemble满足大多数的要求。

Zookeeper集群部署的方式如图：

![zk-clustered](/assets/images/zk-clustered.jpg){:width="65%" height="65%"}

Zookeeper的集群模式，有别于传统的Master/Slave架构，Zookeeper定义了三种角色：**Leader**、**Follower**和**Observer**。其中Oberserver不参与选举过程，Zookeeper引入Observer的目的是为了在不影响整个集群写性能的前提下提高集群读的能力。

## Session
Zookeeper的客户端在向服务端发起请求之前，需要创建一个**会话（Session）**。客户端需要在一个会话内对服务端发起请求，我们前面提到的临时模式下创建的znode，一旦Zookeeper的会话被关闭或超时，这种模式下的znode就会自己被Zookeeper从节点树中删除。

Zookeeper客户端向服务端发起一个TCP连接以后，服务端就会为这个TCP连接维护一个会话，类似于Web应用中的会话的概念，Zookeeper的会话维护在服务端，但是不同于Web应用中的会话，Web应用的会话只能在一个机器上有效，不能跨机器转移，而Zookeeper的会话，可以在集群内部转移，这种机制有利于当其中一个节点宕机以后，客户端可以在会话超时时间内找到集群内另外一个可用的节点，继续在上一个会话中发起请求。

Zookeeper的会话保证了请求的顺序。在Zookeeper的会话中执行的命令，遵循先进先出（FIFO）的顺序。但是Zookeeper不能保证不同会话之间命令执行的顺序。

## 客户端命令
Zookeeper提供了一个默认的客户端程序，在Linux下是Zookeeper根目录下的`./bin/zkCli.sh`。程序提供了一个交互式的shell客户端，支持对Zookeeper的节点进行：创建、查询、更新、删除操作。接下来我们通过例子来看下如何使用这些命令和Zookeeper交互。

首先，我们通过命令`./bin/zkServer.sh start-foreground`以单机模式启动Zookeeper服务。

{% highlight text %}
$ ./bin/zkServer.sh start-foreground

ZooKeeper JMX enabled by default
...
...
2019-02-18 22:50:17,096 [myid:] - INFO  [main:ZooKeeperServer@829] - tickTime set to 2000
2019-02-18 22:50:17,096 [myid:] - INFO  [main:ZooKeeperServer@838] - minSessionTimeout set to -1
2019-02-18 22:50:17,096 [myid:] - INFO  [main:ZooKeeperServer@847] - maxSessionTimeout set to -1
2019-02-18 22:50:17,115 [myid:] - INFO  [main:NIOServerCnxnFactory@89] - binding to port 0.0.0.0/0.0.0.0:2181

{% endhighlight %}

启动参数`start-foreground`让Zookeeper服务在前台启动，可以看到服务启动以后默认监听了2181端口。然后，我们在另外一个终端中，通过命令`./bin/zkCli.sh`启动客户端。

{% highlight text %}
$ ./bin/zkCli.sh

Connecting to localhost:2181
2019-02-18 22:55:28,711 [myid:] - INFO  [main:Environment@100] - Client environment:zookeeper.version=3.4.10-39d3a4f269333c922ed3db283be479f9deacaa0f, built on 03/23/2017 10:13 GMT
2019-02-18 22:55:28,715 [myid:] - INFO  [main:Environment@100] - Client environment:host.name=172.17.55.119
...
...
2019-02-18 22:55:28,720 [myid:] - INFO  [main:ZooKeeper@438] - Initiating client connection, connectString=localhost:2181 sessionTimeout=30000 watcher=org.apache.zookeeper.ZooKeeperMain$MyWatcher@506c589e
Welcome to ZooKeeper!
2019-02-18 22:55:28,746 [myid:] - INFO  [main-SendThread(localhost:2181):ClientCnxn$SendThread@1032] - Opening socket connection to server localhost/0:0:0:0:0:0:0:1:2181. Will not attempt to authenticate using SASL (unknown error)
JLine support is enabled
2019-02-18 22:55:28,834 [myid:] - INFO  [main-SendThread(localhost:2181):ClientCnxn$SendThread@876] - Socket connection established to localhost/0:0:0:0:0:0:0:1:2181, initiating session
[zk: localhost:2181(CONNECTING) 0] 2019-02-18 22:55:28,994 [myid:] - INFO  [main-SendThread(localhost:2181):ClientCnxn$SendThread@1299] - Session establishment complete on server localhost/0:0:0:0:0:0:0:1:2181, sessionid = 0x169011610de0000, negotiated timeout = 30000

WATCHER::

WatchedEvent state:SyncConnected type:None path:null

[zk: localhost:2181(CONNECTED) 0]
{% endhighlight %}

客户端启动以后，进入了一个交互的shell环境，可以输入`?`命令查看所有客户端支持的所有命令：

{% highlight text %}
[zk: localhost:2181(CONNECTED) 6] ?
ZooKeeper -server host:port cmd args
	stat path [watch]
	set path data [version]
	ls path [watch]
	delquota [-n|-b] path
	ls2 path [watch]
	setAcl path acl
	setquota -n|-b val path
	history
	redo cmdno
	printwatches on|off
	delete path [version]
	sync path
	listquota path
	rmr path
	get path [watch]
	create [-s] [-e] path data acl
	addauth scheme auth
	quit
	getAcl path
	close
	connect host:port
[zk: localhost:2181(CONNECTED) 7]
{% endhighlight %}

### 创建节点
命令`create path data`在Zookeeper上创建一个path节点。默认创建的节点是持久模式的普通节点。

{% highlight text %}
zk: localhost:2181(CONNECTED) 3] create /test ""
Created /test
[zk: localhost:2181(CONNECTED) 4] ls /
[zookeeper, test]
{% endhighlight %}

我们通过`ls`命令可以查看根节点下的子节点，可以看到我们通过`create`命令创建的`/test`节点。

我们可以通过`create`命令的`-s`选项，创建顺序节点。通过参数中path指定的节点前缀`seq-`，Zookeeper自动创建了一个唯一的节点名称。

{% highlight text %}
[zk: localhost:2181(CONNECTED) 5] create -s /seq- ""
Created /seq-0000000043
[zk: localhost:2181(CONNECTED) 6] ls  /
[zookeeper, test, seq-0000000043]
{% endhighlight %}

create命令支持`-e`选项来创建临时模式的节点，我们先创建一个临时模式的节点：

{% highlight text %}
[zk: localhost:2181(CONNECTED) 7] create -e /enode ""
Created /enode
[zk: localhost:2181(CONNECTED) 8] ls /
[zookeeper, test, enode, seq-0000000043]
{% endhighlight %}

可以看到，创建完以后可以通过`ls /`命令看到这个临时节点`enode`。然后，我们打开一个新的zk客户端，通过`ls /`命令查看，可以看到enode节点存在。

{% highlight text %}
[zk: localhost:2181(CONNECTED) 0] ls /
[zookeeper, test, enode, seq-0000000043]
{% endhighlight %}

然后我们把创建这个enode的客户端通过`quit`命令关闭，然后在刚才的新创建的那个客户端中通过`ls /`命令查看，可以看到刚才创建的那个enode被删除了。

{% highlight text %}
[zk: localhost:2181(CONNECTED) 10] quit
Quitting...
2019-02-19 23:33:39,496 [myid:] - INFO  [main:ZooKeeper@684] - Session: 0x16906510d630000 closed
2019-02-19 23:33:39,506 [myid:] - INFO  [main-EventThread:ClientCnxn$EventThread@519] - EventThread shut down for session: 0x16906510d630000
{% endhighlight %}

{% highlight text %}
[zk: localhost:2181(CONNECTED) 1] ls /
[zookeeper, test, seq-0000000043]
{% endhighlight %}

### 查看节点
命令`ls`类似于*nix下的`ls`命令，可以查看Zookeeper节点树中指定节点下的子节点。`get`命令可以查看节点的内容，`ls2`命令结合了`ls`和`get`的功能，可以输出子节点和当前节点的内容和属性。`stat`命令可以查看节点的属性。

{% highlight text %}
[zk: localhost:2181(CONNECTED) 5] ls /
[zookeeper]
[zk: localhost:2181(CONNECTED) 10] get /

cZxid = 0x0
ctime = Thu Jan 01 08:00:00 CST 1970
mZxid = 0x0
mtime = Thu Jan 01 08:00:00 CST 1970
pZxid = 0x1fb
cversion = 90
dataVersion = 0
aclVersion = 0
ephemeralOwner = 0x0
dataLength = 0
numChildren = 2
[zk: localhost:2181(CONNECTED) 6] ls2 /
[zookeeper]
cZxid = 0x0
ctime = Thu Jan 01 08:00:00 CST 1970
mZxid = 0x0
mtime = Thu Jan 01 08:00:00 CST 1970
pZxid = 0x1fa
cversion = 89
dataVersion = 0
aclVersion = 0
ephemeralOwner = 0x0
dataLength = 0
numChildren = 1
[zk: localhost:2181(CONNECTED) 15] stat /
cZxid = 0x0
ctime = Thu Jan 01 08:00:00 CST 1970
mZxid = 0x1fc
mtime = Fri Mar 08 22:07:38 CST 2019
pZxid = 0x1fb
cversion = 90
dataVersion = 1
aclVersion = 0
ephemeralOwner = 0x0
dataLength = 4
numChildren = 2
{% endhighlight %}

### 更新节点
命令`set`可以设置节点的值。

{% highlight text %}
[zk: localhost:2181(CONNECTED) 12] set / test
cZxid = 0x0
ctime = Thu Jan 01 08:00:00 CST 1970
mZxid = 0x1fc
mtime = Fri Mar 08 22:07:38 CST 2019
pZxid = 0x1fb
cversion = 90
dataVersion = 1
aclVersion = 0
ephemeralOwner = 0x0
dataLength = 4
numChildren = 2
[zk: localhost:2181(CONNECTED) 13] get /
test
cZxid = 0x0
ctime = Thu Jan 01 08:00:00 CST 1970
mZxid = 0x1fc
mtime = Fri Mar 08 22:07:38 CST 2019
pZxid = 0x1fb
cversion = 90
dataVersion = 1
aclVersion = 0
ephemeralOwner = 0x0
dataLength = 4
numChildren = 2
{% endhighlight %}

### 删除节点
通过`delete`命令可以删除节点，如果节点下存在子节点，则删除失败。

{% highlight text %}
[zk: localhost:2181(CONNECTED) 20] create -s /test/test- ""
Created /test/test-0000000000
[zk: localhost:2181(CONNECTED) 21] ls /test
[test-0000000000]
[zk: localhost:2181(CONNECTED) 22] delete /test
Node not empty: /test
[zk: localhost:2181(CONNECTED) 23] delete /test/test-0000000000
[zk: localhost:2181(CONNECTED) 24] delete /test
[zk: localhost:2181(CONNECTED) 25] ls /test
Node does not exist: /test
[zk: localhost:2181(CONNECTED) 26] ls /
[zookeeper]
{% endhighlight %}
